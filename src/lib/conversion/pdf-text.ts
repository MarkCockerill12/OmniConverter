import { allGlyphs, boundsOf, fillHex, glyphId, interpretPage, pageSpace, type Rect } from "./pdf-content";
import { createFontCache, type FontFamily } from "./pdf-fonts";

/**
 * The text a PDF actually contains, read from its content streams and grouped
 * into lines and runs (a run is one stretch of a line in one font, size and
 * colour). Every box is in display points from the page's top-left, matching
 * the editor's annotation space; every glyph keeps the id the rewriter uses.
 */

export type GlyphSpan = [number, number, number];

export interface PdfTextRun {
  id: string;
  text: string;
  glyphs: GlyphSpan[];
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  color: string;
  font: string;
  line: number;
  editable: boolean;
}

export interface PdfTextGlyph {
  seq: number;
  index: number;
  ch: string;
  box: Rect;
  run: number;
  /** A word gap sits before this glyph. */
  gap: boolean;
}

export interface PdfPageText {
  runs: PdfTextRun[];
  glyphs: PdfTextGlyph[];
}

export interface PdfFontSummary {
  name: string;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  /** Characters the font can show again without falling back to another font. */
  covers: string;
}

export interface PdfDocText {
  pages: PdfPageText[];
  fonts: Record<string, PdfFontSummary>;
}

export function compressSpans(ids: { seq: number; index: number }[]): GlyphSpan[] {
  const spans: GlyphSpan[] = [];
  for (const { seq, index } of ids) {
    const last = spans[spans.length - 1];
    if (last && last[0] === seq && last[2] === index - 1) last[2] = index;
    else spans.push([seq, index, index]);
  }
  return spans;
}

export function expandSpans(spans: GlyphSpan[] = []): string[] {
  const out: string[] = [];
  for (const [seq, from, to] of spans) for (let i = from; i <= to; i++) out.push(`${seq}:${i}`);
  return out;
}

export async function readPdfText(file: Blob, password?: string): Promise<PdfDocText> {
  const lib = await import("@cantoo/pdf-lib");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.PDFDocument.load(bytes, password ? { password } : {});
  const fonts = await createFontCache(lib, doc);
  const seen = new Map<string, ReturnType<typeof fonts.get>>();
  const pages: PdfPageText[] = [];

  for (const page of doc.getPages()) {
    const space = pageSpace(page);
    const runs: PdfTextRun[] = [];
    const glyphs: PdfTextGlyph[] = [];
    let line = -1;
    let prev: { o: { x: number; y: number }; d: [number, number]; width: number; key: string } | null = null;
    let current: { run: PdfTextRun; ids: { seq: number; index: number }[]; boxes: number[] } | null = null;
    const close = () => {
      if (!current) return;
      const box = boundsOf(current.boxes);
      Object.assign(current.run, box, { glyphs: compressSpans(current.ids) });
      current = null;
    };

    let interpreted;
    try { interpreted = interpretPage(lib, fonts, page); } catch { pages.push({ runs, glyphs }); continue; }
    for (const g of allGlyphs(interpreted)) {
      seen.set(g.font.id, g.font);
      const o = space.toDisplay(g.origin[0], g.origin[1]);
      const tip = space.toDisplay(g.origin[0] + g.dir[0], g.origin[1] + g.dir[1]);
      const d: [number, number] = [tip.x - o.x, tip.y - o.y];
      const corners = [
        space.toDisplay(g.bbox.x, g.bbox.y), space.toDisplay(g.bbox.x + g.bbox.width, g.bbox.y + g.bbox.height),
      ];
      const box = boundsOf([corners[0].x, corners[0].y, corners[1].x, corners[1].y]);
      const color = fillHex(g.fill);
      const key = `${g.font.id}|${Math.round(g.size * 10)}|${color}|${g.invisible}`;
      const size = g.size || 1;

      let newLine = !prev;
      let newRun = !prev;
      let gap = false;
      if (prev) {
        const end = { x: prev.o.x + prev.d[0] * prev.width, y: prev.o.y + prev.d[1] * prev.width };
        const along = (o.x - end.x) * prev.d[0] + (o.y - end.y) * prev.d[1];
        const perp = Math.abs((o.x - prev.o.x) * prev.d[1] - (o.y - prev.o.y) * prev.d[0]);
        const sameDir = d[0] * prev.d[0] + d[1] * prev.d[1] > 0.995;
        newLine = !sameDir || perp > 0.35 * size || along < -0.6 * size || along > 3 * size;
        newRun = newLine || along > 1.5 * size || key !== prev.key;
        gap = !newLine && along > 0.18 * size;
      }
      if (newLine) line++;
      if (newRun) {
        close();
        const horizontal = Math.abs(d[1]) < 0.05 && d[0] > 0;
        current = {
          run: {
            id: glyphId(g), text: "", glyphs: [], x: 0, y: 0, width: 0, height: 0, size: g.size, color, font: g.font.id, line,
            editable: horizontal && !g.font.type3 && !g.invisible,
          },
          ids: [], boxes: [],
        };
        runs.push(current.run);
      }
      const run = current!;
      const spaced = gap && !run.run.text.endsWith(" ") && g.unicode !== " ";
      if (spaced && !newRun) run.run.text += " ";
      run.run.text += g.unicode;
      run.ids.push({ seq: g.seq, index: g.index });
      run.boxes.push(box.x, box.y, box.x + box.width, box.y + box.height);
      glyphs.push({ seq: g.seq, index: g.index, ch: g.unicode, box, run: runs.length - 1, gap });
      prev = { o, d, width: g.width, key };
    }
    close();
    pages.push({ runs, glyphs });
  }

  const summaries: Record<string, PdfFontSummary> = {};
  for (const [id, font] of seen) {
    if (!font) continue;
    const covers = new Set<string>();
    const codes = font.subset || font.twoByte ? font.used : new Set(Array.from({ length: 224 }, (_, i) => i + 32));
    for (const code of codes) {
      const ch = font.unicode(code);
      if (ch.length === 1 && font.codeFor(ch) !== undefined && font.canShow(font.codeFor(ch)!)) covers.add(ch);
    }
    summaries[id] = { name: font.name, family: font.family, bold: font.bold, italic: font.italic, covers: [...covers].join("") };
  }
  return { pages, fonts: summaries };
}

export const REDACT_PRESETS: { label: string; name: string; pattern: RegExp }[] = [
  { label: "Emails", name: "emails", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { label: "Phones", name: "phone numbers", pattern: /\+?\(?\d[\d ().-]{7,}\d/g },
  { label: "Numbers", name: "card & account numbers", pattern: /\b\d(?:[ -]?\d){7,}\b/g },
];

export function textPattern(query: string, matchCase = false) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), matchCase ? "g" : "gi");
}

/** Every match of `pattern` on a page: one box per match per line, with its glyphs. */
export function findInPage(page: PdfPageText, pattern: RegExp): { box: Rect; glyphs: GlyphSpan[] }[] {
  const lines = new Map<number, PdfTextGlyph[]>();
  for (const g of page.glyphs) {
    const line = page.runs[g.run].line;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line)!.push(g);
  }
  const out: { box: Rect; glyphs: GlyphSpan[] }[] = [];
  for (const glyphs of lines.values()) {
    let text = "";
    const owner: (PdfTextGlyph | null)[] = [];
    for (const g of glyphs) {
      if (g.gap && text && !text.endsWith(" ") && g.ch !== " ") { text += " "; owner.push(null); }
      for (const ch of g.ch) { text += ch; owner.push(g); }
    }
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))) {
      if (!m[0].trim()) continue;
      const hit = [...new Set(owner.slice(m.index, m.index + m[0].length).filter((g): g is PdfTextGlyph => !!g && g.ch.trim() !== ""))];
      if (!hit.length) continue;
      const box = boundsOf(hit.flatMap((g) => [g.box.x, g.box.y, g.box.x + g.box.width, g.box.y + g.box.height]));
      out.push({ box, glyphs: compressSpans(hit) });
    }
  }
  return out;
}
