import type { PDFDict, PDFDocument, PDFObject, PDFPage, PDFRef } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import type { PdfAnnotation } from "@/lib/formats";
import {
  apply, boundsOf, fillHex, glyphId, interpretPage, overlap, pageSpace, type Glyph, type Rect, type StreamRun,
} from "./pdf-content";
import { createFontCache, standardFontName, type FontCache } from "./pdf-fonts";
import { inlineToStream, redactImage } from "./pdf-redact-images";
import { fmt, isDict, isName, isStr, serialize, type Op, type Operand } from "./pdf-syntax";
import { expandSpans } from "./pdf-text";

/**
 * True redaction and in-place text replacement. Content streams are rewritten
 * so that what sits under a redaction box is gone from the file, not hidden:
 * glyphs are cut out of their show operators (with the spacing they took kept,
 * so nothing else moves), drawings inside the box are dropped, image pixels
 * under it are overwritten, and annotations or form fields it touches are
 * deleted. A final sweep removes every object nothing refers to any more,
 * which is where the old content streams and images would otherwise survive.
 */

type Lib = typeof import("@cantoo/pdf-lib");

export interface PageWork {
  /** Redaction boxes in user space. */
  rects: Rect[];
  /** Glyphs to remove regardless of position (`seq:index`). */
  glyphs: Set<string>;
  /** Colour painted into redacted image pixels. */
  color: [number, number, number];
}

const hitsGlyph = (rects: Rect[], b: Rect) => rects.some((r) => {
  const o = overlap(b, r);
  return o.width > 0.25 && o.height > 0.25;
});
const inside = (r: Rect, b: Rect, tol = 0.5) =>
  b.x >= r.x - tol && b.y >= r.y - tol && b.x + b.width <= r.x + r.width + tol && b.y + b.height <= r.y + r.height + tol;

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** Re-emits a show operator with some of its glyphs replaced by equal spacing. */
function rebuildShow(op: Op, show: StreamRun["shows"][number], removed: boolean[]): string {
  const font = show.font!;
  const items: Operand[] = op.op === "TJ" ? (Array.isArray(op.args[0]) ? op.args[0] : []) : [op.args[op.op === "\"" ? 2 : 0]];
  const parts: string[] = [];
  let chunk: number[] = [];
  let shift = 0;
  const flushChunk = () => { if (chunk.length) { parts.push(`<${hex(chunk)}>`); chunk = []; } };
  const flushShift = () => { if (shift) { parts.push(fmt(shift)); shift = 0; } };
  let g = 0;
  for (const item of items) {
    if (typeof item === "number") { flushChunk(); shift += item; continue; }
    if (!isStr(item)) continue;
    const b = item.v;
    for (let i = 0; i < b.length; ) {
      const n = Math.max(1, font.codeLength(b, i));
      const bytes = Array.from(b.subarray(i, i + n));
      const code = bytes.reduce((acc, v) => acc * 256 + v, 0);
      i += n;
      if (removed[g++]) {
        flushChunk();
        // A glyph advances (w·Tfs + Tc + Tw)·Th; a TJ number n advances −n/1000·Tfs·Th.
        if (show.tfs) shift -= ((font.width(code) * show.tfs + show.tc + (n === 1 && code === 32 ? show.tw : 0)) * 1000) / show.tfs;
      } else {
        flushShift();
        chunk.push(...bytes);
      }
    }
  }
  flushChunk();
  flushShift();
  const prefix = op.op === "'" ? "T* " : op.op === "\"" ? `${serialize(op.args[0])} Tw ${serialize(op.args[1])} Tc T* ` : "";
  return `${prefix}[${parts.join(" ")}] TJ`;
}

function freshName(resources: PDFDict | undefined, lib: Lib, taken: Set<string>) {
  const xo = resources?.lookupMaybe(lib.PDFName.of("XObject"), lib.PDFDict);
  for (let i = 1; ; i++) {
    const name = `OmniR${i}`;
    if (!taken.has(name) && !xo?.has(lib.PDFName.of(name))) { taken.add(name); return name; }
  }
}

/**
 * The stream's resources with the redacted copies added under new names and
 * the originals they replace taken out: a name left behind would keep the
 * unredacted object referenced, and so in the saved file.
 */
function withXObjects(lib: Lib, doc: PDFDocument, resources: PDFDict | undefined, add: Map<string, PDFRef>, drop: Set<string>) {
  const N = lib.PDFName.of;
  const res = resources ? resources.clone(doc.context) : doc.context.obj({});
  const xo = res.lookupMaybe(N("XObject"), lib.PDFDict);
  const next = xo ? xo.clone(doc.context) : doc.context.obj({});
  for (const name of drop) next.delete(N(name));
  for (const [name, ref] of add) next.set(N(name), ref);
  res.set(N("XObject"), next);
  return res;
}

// ---- Content rewrite ------------------------------------------------------

/**
 * Applies one page's redactions and glyph removals. Returns every glyph the
 * page showed (as it was before), so replacement text can be placed.
 */
export async function rewritePage(lib: Lib, doc: PDFDocument, fonts: FontCache, page: PDFPage, work: PageWork): Promise<Glyph[]> {
  const N = lib.PDFName.of;
  const root = interpretPage(lib, fonts, page);
  const glyphs: Glyph[] = [];
  const removed = new Set<Glyph>();
  const tainted = new Set<string>();
  const runs: StreamRun[] = [];
  const runId = new Map<StreamRun, number>();
  const collect = (run: StreamRun) => {
    runId.set(run, runs.push(run) - 1);
    for (const show of run.shows) for (const g of show.glyphs) {
      glyphs.push(g);
      if (work.glyphs.has(glyphId(g)) || hitsGlyph(work.rects, g.core)) {
        removed.add(g);
        for (const m of g.marks) tainted.add(`${runs.indexOf(m.run)}:${m.op}`);
      }
    }
    run.forms.forEach((f) => collect(f.run));
  };
  collect(root);

  // Images under a box get a redacted copy (async, so done before the rewrite).
  const imageRefs = new Map<string, PDFRef>();
  if (work.rects.length) {
    for (const run of runs) {
      for (const image of run.images) {
        const quad = boundsOf([...apply(image.ctm, 0, 0), ...apply(image.ctm, 1, 0), ...apply(image.ctm, 1, 1), ...apply(image.ctm, 0, 1)]);
        if (!work.rects.some((r) => { const o = overlap(quad, r); return o.width > 0 && o.height > 0; })) continue;
        const op = run.ops[image.op];
        const stream = image.stream ?? inlineToStream(lib, doc, op, run.resources);
        const ref = await redactImage(lib, doc, stream, image.ctm, work.rects, work.color);
        if (ref) imageRefs.set(`${runId.get(run)}:${image.op}`, ref);
      }
    }
  }

  const rewrite = (run: StreamRun): { bytes: Uint8Array; resources?: PDFDict } | null => {
    const id = runId.get(run)!;
    const edits: { from: number; to: number; text: string }[] = [];
    const names = new Map<string, PDFRef>();
    const taken = new Set<string>();
    const replacedOps = new Set<number>();
    const replaceDo = (opIndex: number, ref: PDFRef) => {
      const name = freshName(run.resources, lib, taken);
      names.set(name, ref);
      replacedOps.add(opIndex);
      const op = run.ops[opIndex];
      edits.push({ from: op.start, to: op.end, text: `/${name} Do` });
    };

    for (const show of run.shows) {
      const flags = show.glyphs.map((g) => removed.has(g));
      if (flags.some(Boolean)) {
        const op = run.ops[show.op];
        edits.push({ from: op.start, to: op.end, text: rebuildShow(op, show, flags) });
      }
    }
    for (const path of run.paths) {
      if (path.clip || !path.bbox || !work.rects.some((r) => inside(r, path.bbox!))) continue;
      edits.push({ from: run.ops[path.from].start, to: run.ops[path.to].end, text: "" });
    }
    for (const image of run.images) {
      const ref = imageRefs.get(`${id}:${image.op}`);
      if (ref) replaceDo(image.op, ref);
    }
    for (const form of run.forms) {
      const child = rewrite(form.run);
      if (!child) continue;
      const dict = form.stream.dict.clone(doc.context);
      for (const key of ["DecodeParms", "Length"]) dict.delete(N(key));
      dict.set(N("Filter"), N("FlateDecode"));
      if (child.resources) dict.set(N("Resources"), child.resources);
      replaceDo(form.op, doc.context.register(lib.PDFRawStream.of(dict, zlibSync(child.bytes))));
    }
    // Marked content around removed text can spell it out again (/ActualText, /Alt).
    run.ops.forEach((op, i) => {
      if (op.op !== "BDC" || !tainted.has(`${id}:${i}`) || !isDict(op.args[1])) return;
      const props = new Map(op.args[1].v);
      if (!["ActualText", "Alt", "E"].some((k) => props.delete(k))) return;
      edits.push({ from: op.start, to: op.end, text: `${serialize(op.args[0])} ${serialize({ t: "dict", v: props })} BDC` });
    });

    if (!edits.length) return null;
    edits.sort((a, b) => a.from - b.from);
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    let cursor = 0;
    for (const edit of edits) {
      if (edit.from < cursor) continue;
      parts.push(run.bytes.subarray(cursor, edit.from), encoder.encode(` ${edit.text} `));
      cursor = edit.to;
    }
    parts.push(run.bytes.subarray(cursor));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    // Inline images are replaced too but never had a name.
    const nameAt = (i: number) => (run.ops[i].op === "Do" && isName(run.ops[i].args[0]) ? (run.ops[i].args[0] as { v: string }).v : null);
    const stillUsed = new Set(run.ops.map((_, i) => (replacedOps.has(i) ? null : nameAt(i))).filter((n): n is string => !!n));
    const drop = new Set([...replacedOps].map(nameAt).filter((n): n is string => !!n && !stillUsed.has(n)));
    return { bytes, resources: names.size ? withXObjects(lib, doc, run.resources, names, drop) : undefined };
  };

  const result = rewrite(root);
  if (result) {
    page.node.set(N("Contents"), doc.context.obj([doc.context.register(doc.context.flateStream(result.bytes))]));
    if (result.resources) page.node.set(N("Resources"), result.resources);
  }
  if (work.rects.length) removeAnnotations(lib, doc, page, work.rects);
  return glyphs;
}

/** Deletes annotations (and the form fields behind widgets) that a box touches. */
function removeAnnotations(lib: Lib, doc: PDFDocument, page: PDFPage, rects: Rect[]) {
  const N = lib.PDFName.of;
  const annots = page.node.Annots();
  if (!annots) return;
  const widgets: PDFDict[] = [];
  for (let i = annots.size() - 1; i >= 0; i--) {
    const dict = annots.lookupMaybe(i, lib.PDFDict);
    const rect = dict?.lookupMaybe(N("Rect"), lib.PDFArray)?.asArray().map((v) => (doc.context.lookup(v) as { asNumber?: () => number })?.asNumber?.() ?? 0);
    if (!dict || !rect || rect.length < 4) continue;
    const box = { x: Math.min(rect[0], rect[2]), y: Math.min(rect[1], rect[3]), width: Math.abs(rect[2] - rect[0]), height: Math.abs(rect[3] - rect[1]) };
    if (!rects.some((r) => { const o = overlap(box, r); return o.width > 0 && o.height > 0; })) continue;
    if (dict.lookup(N("Subtype")) === N("Widget")) { widgets.push(dict); continue; }
    const popup = dict.get(N("Popup"));
    annots.remove(i);
    if (popup) {
      const at = annots.asArray().findIndex((v) => v === popup);
      if (at !== -1) annots.remove(at);
    }
  }
  if (!widgets.length) return;
  const form = doc.getForm();
  for (const field of form.getFields()) {
    if (field.acroField.getWidgets().some((w) => widgets.includes(w.dict))) {
      try { form.removeField(field); } catch { /* malformed field tree */ }
    }
  }
}

// ---- Replacement text -------------------------------------------------------

export interface Replacement {
  text: string;
  /** Display-space move of the line, in points. */
  dx: number;
  dy: number;
  size: number;
  sourceSize: number;
  color: string;
  font: "match" | "sans" | "serif" | "mono";
  bold?: boolean;
  italic?: boolean;
}

/** Writes new text where `first` (the original line's first glyph) began. */
export async function drawReplacement(lib: Lib, doc: PDFDocument, page: PDFPage, first: Glyph, edit: Replacement) {
  if (!edit.text) return;
  const space = pageSpace(page);
  const font = first.font;
  const codes = [...edit.text].map((ch) => font.codeFor(ch));
  const reuse = edit.font === "match" && !font.type3 && codes.every((c) => c !== undefined && font.canShow(c));

  const at = space.toDisplay(first.origin[0], first.origin[1]);
  const base = space.toUser(0, 0);
  const moved = space.toUser(edit.dx, edit.dy);
  const ux = moved.x - base.x;
  const uy = moved.y - base.y;

  if (reuse) {
    const ref = font.ref ?? doc.context.register(font.dict);
    const name = page.node.newFontDictionary("OmniEdit", ref);
    const scale = edit.sourceSize ? edit.size / edit.sourceSize : 1;
    const sameColor = edit.color.toLowerCase() === fillHex(first.fill);
    const color = sameColor ? `${first.fill.comps.map(fmt).join(" ")} ${first.fill.space}` : (() => {
      const v = edit.color.replace("#", "");
      return `${[0, 2, 4].map((i) => fmt(parseInt(v.slice(i, i + 2), 16) / 255)).join(" ")} rg`;
    })();
    const bytes = codes.map((c) => (font.twoByte ? [(c! >> 8) & 255, c! & 255] : [c! & 255])).flat();
    const content = [
      "q", `1 0 0 1 ${fmt(ux)} ${fmt(uy)} cm`, `${first.ctm.map(fmt).join(" ")} cm`, "BT",
      `${serialize({ t: "name", v: name.decodeText() })} ${fmt(first.tfs * scale)} Tf`,
      `${fmt(first.tc)} Tc ${fmt(first.tw)} Tw ${fmt(first.th * 100)} Tz ${fmt(first.ts)} Ts ${first.tr} Tr`,
      color, `${first.tm.map(fmt).join(" ")} Tm`, `<${hex(bytes)}> Tj`, "ET", "Q",
    ].join("\n");
    page.node.normalize();
    page.node.addContentStream(doc.context.register(doc.context.flateStream(content)));
    return;
  }

  const family = edit.font === "match" ? font.family : edit.font;
  const bold = edit.font === "match" ? font.bold : !!edit.bold;
  const italic = edit.font === "match" ? font.italic : !!edit.italic;
  const pdfFont = await doc.embedFont(standardFontName(family, bold, italic));
  // The standard fonts only cover WinAnsi.
  const known = new Set(pdfFont.getCharacterSet());
  const text = Array.from(edit.text, (ch) => (known.has(ch.codePointAt(0)!) ? ch : "?")).join("");
  const v = edit.color.replace("#", "");
  const user = space.toUser(at.x + edit.dx, at.y + edit.dy);
  page.drawText(text, {
    x: user.x, y: user.y, size: edit.size, font: pdfFont,
    color: lib.rgb(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255),
    rotate: lib.degrees(space.rotation),
  });
}

// ---- Orchestration ----------------------------------------------------------

/** An edit that leaves its line exactly as it was needs no rewrite. */
function editChanges(ann: PdfAnnotation) {
  const src = ann.source;
  if (!src) return false;
  return ann.text !== src.text || (ann.size ?? src.size) !== src.size || (ann.color ?? src.color) !== src.color
    || (ann.font ?? "match") !== "match" || ann.x !== src.x || ann.y !== src.y;
}

/** Redactions and text edits: rewrites the affected pages' content. True when anything changed. */
export async function applyContentEdits(lib: Lib, doc: PDFDocument, keys: string[], annotations: PdfAnnotation[]): Promise<boolean> {
  const work = annotations.filter((a) => a.type === "redact" || (a.type === "edit" && editChanges(a)));
  if (!work.length) return false;
  const fonts = await createFontCache(lib, doc);
  const pages = doc.getPages();
  // A subset font holds only the glyphs the document shows somewhere, so read
  // every page before deciding whether an edit can keep its original font.
  if (work.some((a) => a.type === "edit" && (a.font ?? "match") === "match")) {
    for (const page of pages) {
      try { interpretPage(lib, fonts, page); } catch { /* unreadable page: its glyphs just do not count */ }
    }
  }

  for (const [index, page] of pages.entries()) {
    const mine = work.filter((a) => a.page === keys[index]);
    if (!mine.length) continue;
    const space = pageSpace(page);
    const redacts = mine.filter((a) => a.type === "redact");
    const edits = mine.filter((a) => a.type === "edit");
    const shade = (redacts[0]?.color ?? "#000000").replace("#", "");
    const glyphs = await rewritePage(lib, doc, fonts, page, {
      rects: redacts.map((a) => space.rectToUser(a)),
      glyphs: new Set(mine.flatMap((a) => expandSpans(a.glyphs))),
      color: [0, 2, 4].map((i) => parseInt(shade.slice(i, i + 2), 16) || 0) as [number, number, number],
    });
    const byId = new Map(glyphs.map((g) => [glyphId(g), g]));
    for (const edit of edits) {
      const first = byId.get(expandSpans(edit.glyphs)[0] ?? "");
      const src = edit.source!;
      if (!first || !edit.text) continue;
      await drawReplacement(lib, doc, page, first, {
        text: edit.text, dx: edit.x - src.x, dy: edit.y - src.y, size: edit.size ?? src.size, sourceSize: src.size,
        color: edit.color ?? src.color, font: edit.font ?? "match", bold: edit.bold, italic: edit.italic,
      });
    }
  }
  return true;
}

// ---- Clean-up ---------------------------------------------------------------

/** Deletes every indirect object the document no longer refers to. */
export function sweepUnreachable(lib: Lib, doc: PDFDocument) {
  const { context } = doc;
  const seen = new Set<PDFRef>();
  const stack: (PDFObject | undefined)[] = [context.trailerInfo.Root, context.trailerInfo.Info, context.trailerInfo.Encrypt];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    if (obj instanceof lib.PDFRef) {
      if (seen.has(obj)) continue;
      seen.add(obj);
      stack.push(context.lookup(obj));
    } else if (obj instanceof lib.PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof lib.PDFArray) {
      stack.push(...obj.asArray());
    } else if (obj instanceof lib.PDFStream) {
      stack.push(obj.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) if (!seen.has(ref)) context.delete(ref);
}

