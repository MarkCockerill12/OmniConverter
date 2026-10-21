import type { PDFDict, PDFPage, PDFRawStream } from "@cantoo/pdf-lib";
import type { FontCache, FontInfo } from "./pdf-fonts";
import { asNum, isName, isStr, parseContent, type Op, type Operand } from "./pdf-syntax";

/**
 * Content-stream interpretation: tracks the graphics and text state far enough
 * to know where every glyph, path and image a page draws lands on it.
 */

type Lib = typeof import("@cantoo/pdf-lib");

export type Matrix = [number, number, number, number, number, number];
export interface Rect { x: number; y: number; width: number; height: number }

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** a then b: points go through `a` first. */
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}
export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export function boundsOf(points: number[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]);
    y0 = Math.min(y0, points[i + 1]); y1 = Math.max(y1, points[i + 1]);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
export const overlap = (a: Rect, b: Rect) => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

/**
 * Maps display coordinates (points from the top-left of the page as a viewer
 * shows it) to and from the page's own user space, whatever its /Rotate says.
 */
export function pageSpace(page: PDFPage) {
  const box = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const sideways = rotation % 180 !== 0;
  const toUser = (u: number, v: number) => {
    switch (rotation) {
      case 90: return { x: box.x + v, y: box.y + u };
      case 180: return { x: box.x + box.width - u, y: box.y + v };
      case 270: return { x: box.x + box.width - v, y: box.y + box.height - u };
      default: return { x: box.x + u, y: box.y + box.height - v };
    }
  };
  const toDisplay = (x: number, y: number) => {
    switch (rotation) {
      case 90: return { x: y - box.y, y: x - box.x };
      case 180: return { x: box.x + box.width - x, y: y - box.y };
      case 270: return { x: box.y + box.height - y, y: box.x + box.width - x };
      default: return { x: x - box.x, y: box.y + box.height - y };
    }
  };
  /** A display-space rectangle as a user-space one. */
  const rectToUser = (r: Rect): Rect => {
    const a = toUser(r.x, r.y);
    const b = toUser(r.x + r.width, r.y + r.height);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  };
  return { rotation, toUser, toDisplay, rectToUser, width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
}

export interface Fill { space: "g" | "rg" | "k"; comps: number[] }
export function fillHex(fill: Fill) {
  const [r, g, b] = fill.space === "g" ? [fill.comps[0], fill.comps[0], fill.comps[0]]
    : fill.space === "k" ? fill.comps.slice(0, 3).map((c) => (1 - c) * (1 - (fill.comps[3] ?? 0)))
    : fill.comps;
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, "0")).join("");
}

export interface Glyph {
  seq: number;
  index: number;
  code: number;
  unicode: string;
  font: FontInfo;
  /** Axis-aligned box in user space. */
  bbox: Rect;
  /**
   * Baseline to roughly x-height: what a redaction box must touch to take the
   * glyph. Full ascent/descent boxes of neighbouring lines overlap.
   */
  core: Rect;
  /** Baseline start and unit direction, in user space. */
  origin: [number, number];
  dir: [number, number];
  /** Visual width along the baseline and font size, in user space. */
  width: number;
  size: number;
  invisible: boolean;
  fill: Fill;
  /** State needed to show text again exactly here. */
  tm: Matrix;
  ctm: Matrix;
  tfs: number;
  tc: number;
  tw: number;
  th: number;
  ts: number;
  tr: number;
  /** Marked-content sections (BDC) open around the glyph. */
  marks: { run: StreamRun; op: number }[];
}

export interface StreamRun {
  bytes: Uint8Array;
  ops: Op[];
  resources?: PDFDict;
  shows: { op: number; glyphs: Glyph[]; tfs: number; tc: number; tw: number; font: FontInfo | null }[];
  paths: { from: number; to: number; bbox: Rect | null; clip: boolean }[];
  images: { op: number; ctm: Matrix; stream?: PDFRawStream }[];
  forms: { op: number; stream: PDFRawStream; run: StreamRun }[];
}

interface GState {
  ctm: Matrix; font: FontInfo | null; tfs: number; tc: number; tw: number; th: number; tl: number; ts: number; tr: number; fill: Fill;
}

/** Concatenated, decoded content of a page (or any content stream list). */
export function contentBytes(lib: Lib, page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  const list = contents instanceof lib.PDFArray ? contents.asArray().map((ref) => page.doc.context.lookup(ref)) : [contents];
  const parts: Uint8Array[] = [];
  for (const stream of list) {
    if (stream instanceof lib.PDFRawStream) parts.push(lib.decodePDFRawStream(stream).decode());
    else if (stream && typeof (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents === "function") {
      parts.push((stream as unknown as { getUnencodedContents: () => Uint8Array }).getUnencodedContents());
    }
    parts.push(new Uint8Array([10]));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function pageResources(lib: Lib, page: PDFPage): PDFDict | undefined {
  return page.doc.context.lookupMaybe(page.node.getInheritableAttribute(lib.PDFName.of("Resources")), lib.PDFDict);
}

/** Runs a page's content and records where everything it draws lands. */
export function interpretPage(lib: Lib, fonts: FontCache, page: PDFPage): StreamRun {
  const context = page.doc.context;
  const N = (k: string) => lib.PDFName.of(k);
  let seq = 0;

  const run = (bytes: Uint8Array, resources: PDFDict | undefined, start: GState, depth: number, outerMarks: { run: StreamRun; op: number }[], active: Set<PDFRawStream>): StreamRun => {
    const ops = parseContent(bytes);
    const out: StreamRun = { bytes, ops, resources, shows: [], paths: [], images: [], forms: [] };
    let gs: GState = { ...start };
    const stack: GState[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let marks = outerMarks;
    const markStack: { run: StreamRun; op: number }[][] = [];
    let pathFrom = -1;
    let pathPts: number[] = [];
    let clip = false;

    const sub = (kind: string, name: string) => {
      const group = resources?.lookupMaybe(N(kind), lib.PDFDict);
      return group ? { raw: group.get(N(name)), value: context.lookup(group.get(N(name))) } : undefined;
    };
    const setFill = (comps: number[]) => {
      if (comps.length === 1) gs.fill = { space: "g", comps };
      else if (comps.length === 3) gs.fill = { space: "rg", comps };
      else if (comps.length === 4) gs.fill = { space: "k", comps };
    };

    const show = (opIndex: number, items: Operand[]) => {
      const font = gs.font;
      const record = { op: opIndex, glyphs: [] as Glyph[], tfs: gs.tfs, tc: gs.tc, tw: gs.tw, font };
      out.shows.push(record);
      const mySeq = seq++;
      if (!font) return;
      let index = 0;
      for (const item of items) {
        if (typeof item === "number") {
          tm = mul([1, 0, 0, 1, (-item / 1000) * gs.tfs * gs.th, 0], tm);
          continue;
        }
        if (!isStr(item)) continue;
        const b = item.v;
        for (let i = 0; i < b.length; ) {
          const n = Math.max(1, font.codeLength(b, i));
          let code = 0;
          for (let k = 0; k < n; k++) code = code * 256 + (b[i + k] ?? 0);
          i += n;
          const w = font.width(code);
          const trm = mul([gs.tfs * gs.th, 0, 0, gs.tfs, 0, gs.ts], mul(tm, gs.ctm));
          const quad = [...apply(trm, 0, font.descent), ...apply(trm, w, font.descent), ...apply(trm, w, font.ascent), ...apply(trm, 0, font.ascent)];
          const o = apply(trm, 0, 0);
          const e = apply(trm, w || 0.001, 0);
          const len = Math.hypot(e[0] - o[0], e[1] - o[1]) || 1;
          const textToUser = mul(tm, gs.ctm);
          font.used.add(code);
          record.glyphs.push({
            seq: mySeq, index: index++, code, unicode: font.unicode(code), font,
            bbox: boundsOf(quad),
            core: boundsOf([...apply(trm, 0, 0), ...apply(trm, w, 0), ...apply(trm, w, 0.6 * font.ascent), ...apply(trm, 0, 0.6 * font.ascent)]),
            origin: o, dir: [(e[0] - o[0]) / len, (e[1] - o[1]) / len],
            width: w ? len : 0, size: Math.abs(gs.tfs) * Math.hypot(textToUser[2], textToUser[3]),
            invisible: gs.tr === 3 || gs.tr === 7, fill: gs.fill,
            tm, ctm: gs.ctm, tfs: gs.tfs, tc: gs.tc, tw: gs.tw, th: gs.th, ts: gs.ts, tr: gs.tr, marks,
          });
          const space = n === 1 && code === 32 ? gs.tw : 0;
          tm = mul([1, 0, 0, 1, (w * gs.tfs + gs.tc + space) * gs.th, 0], tm);
        }
      }
    };

    ops.forEach((op, i) => {
      const a = op.args;
      switch (op.op) {
        case "q": stack.push({ ...gs }); break;
        case "Q": if (stack.length) gs = stack.pop()!; break;
        case "cm": gs.ctm = mul(a.map(asNum) as Matrix, gs.ctm); break;
        case "BT": tm = tlm = IDENTITY; break;
        case "Tf": {
          const entry = isName(a[0]) ? sub("Font", a[0].v) : undefined;
          gs.font = entry ? fonts.get(entry.raw) : null;
          gs.tfs = asNum(a[1]);
          break;
        }
        case "Tc": gs.tc = asNum(a[0]); break;
        case "Tw": gs.tw = asNum(a[0]); break;
        case "Tz": gs.th = asNum(a[0]) / 100; break;
        case "TL": gs.tl = asNum(a[0]); break;
        case "Ts": gs.ts = asNum(a[0]); break;
        case "Tr": gs.tr = asNum(a[0]); break;
        case "Td": tm = tlm = mul([1, 0, 0, 1, asNum(a[0]), asNum(a[1])], tlm); break;
        case "TD": gs.tl = -asNum(a[1]); tm = tlm = mul([1, 0, 0, 1, asNum(a[0]), asNum(a[1])], tlm); break;
        case "Tm": tm = tlm = a.map(asNum) as Matrix; break;
        case "T*": tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); break;
        case "Tj": show(i, [a[0]]); break;
        case "TJ": show(i, Array.isArray(a[0]) ? a[0] : []); break;
        case "'": tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); show(i, [a[0]]); break;
        case "\"":
          gs.tw = asNum(a[0]); gs.tc = asNum(a[1]);
          tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
          show(i, [a[2]]);
          break;
        case "g": case "rg": case "k": setFill(a.map(asNum)); break;
        case "sc": case "scn": if (a.every((v) => typeof v === "number")) setFill(a.map(asNum)); break;
        case "cs": gs.fill = { space: "g", comps: [0] }; break;
        case "m": case "l": case "c": case "v": case "y": case "re": {
          if (pathFrom < 0) pathFrom = i;
          if (op.op === "re") {
            const [x, y, w, h] = a.map(asNum);
            pathPts.push(...apply(gs.ctm, x, y), ...apply(gs.ctm, x + w, y), ...apply(gs.ctm, x + w, y + h), ...apply(gs.ctm, x, y + h));
          } else {
            for (let k = 0; k + 1 < a.length; k += 2) pathPts.push(...apply(gs.ctm, asNum(a[k]), asNum(a[k + 1])));
          }
          break;
        }
        case "W": case "W*": clip = true; break;
        case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": case "n":
          out.paths.push({ from: pathFrom < 0 ? i : pathFrom, to: i, bbox: pathPts.length ? boundsOf(pathPts) : null, clip: clip || op.op === "n" });
          pathFrom = -1; pathPts = []; clip = false;
          break;
        case "BI": out.images.push({ op: i, ctm: gs.ctm }); break;
        case "BDC": case "BMC":
          markStack.push(marks);
          marks = [...marks, { run: out, op: i }];
          break;
        case "EMC": if (markStack.length) marks = markStack.pop()!; break;
        case "Do": {
          const entry = isName(a[0]) ? sub("XObject", a[0].v) : undefined;
          const stream = entry?.value instanceof lib.PDFRawStream ? entry.value : undefined;
          if (!stream) break;
          const subtype = stream.dict.lookupMaybe(N("Subtype"), lib.PDFName)?.asString();
          if (subtype === "/Image") out.images.push({ op: i, ctm: gs.ctm, stream });
          else if (subtype === "/Form" && depth < 12 && !active.has(stream)) {
            let decoded: Uint8Array;
            try { decoded = lib.decodePDFRawStream(stream).decode(); } catch { break; }
            const matrix = stream.dict.lookupMaybe(N("Matrix"), lib.PDFArray)?.asArray().map((v) => (context.lookup(v) as { asNumber?: () => number })?.asNumber?.() ?? 0);
            const ctm = matrix?.length === 6 ? mul(matrix as Matrix, gs.ctm) : gs.ctm;
            const own = stream.dict.lookupMaybe(N("Resources"), lib.PDFDict);
            active.add(stream);
            const child = run(decoded, own ?? resources, { ...gs, ctm }, depth + 1, marks, active);
            active.delete(stream);
            out.forms.push({ op: i, stream, run: child });
          }
          break;
        }
      }
    });
    return out;
  };

  const start: GState = { ctm: IDENTITY, font: null, tfs: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, fill: { space: "g", comps: [0] } };
  return run(contentBytes(lib, page), pageResources(lib, page), start, 0, [], new Set());
}

/** Every glyph of a run and its forms, in drawing order. */
export function allGlyphs(run: StreamRun): Glyph[] {
  const out: Glyph[] = [];
  const visit = (r: StreamRun) => {
    const forms = new Map(r.forms.map((f) => [f.op, f.run]));
    const shows = new Map(r.shows.map((s) => [s.op, s]));
    r.ops.forEach((_, i) => {
      const s = shows.get(i);
      if (s) out.push(...s.glyphs);
      const f = forms.get(i);
      if (f) visit(f);
    });
  };
  visit(run);
  return out;
}

export const glyphId = (g: Pick<Glyph, "seq" | "index">) => `${g.seq}:${g.index}`;
