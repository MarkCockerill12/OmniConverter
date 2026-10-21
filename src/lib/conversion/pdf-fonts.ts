import type { PDFDict, PDFDocument, PDFFont, PDFObject, PDFRef } from "@cantoo/pdf-lib";

/**
 * Just enough of a PDF font to place, read and re-encode the glyphs a content
 * stream shows: how many bytes make a character code, how wide each glyph is,
 * what Unicode it stands for, and whether the font can show a given character.
 */

type Lib = typeof import("@cantoo/pdf-lib");

export type FontFamily = "sans" | "serif" | "mono";

export interface FontInfo {
  id: string;
  ref?: PDFRef;
  dict: PDFDict;
  /** BaseFont without a subset prefix. */
  name: string;
  subset: boolean;
  embedded: boolean;
  type3: boolean;
  /** Codes are written as two bytes (Type0 fonts). */
  twoByte: boolean;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  /** Ascent and descent in text space per unit of font size; descent is negative. */
  ascent: number;
  descent: number;
  codeLength(bytes: Uint8Array, at: number): number;
  /** Advance width in text space per unit of font size. */
  width(code: number): number;
  unicode(code: number): string;
  /** The code that shows `ch`, when the font has one. */
  codeFor(ch: string): number | undefined;
  /** Codes seen shown with this font; a subset font holds only these glyphs. */
  used: Set<number>;
  canShow(code: number): boolean;
}

// WinAnsi glyph names for codes 32-126 and 160-255, and Unicode for 128-159.
const ASCII_NAMES = (
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma " +
  "hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at " +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").join(" ") +
  " bracketleft backslash bracketright asciicircum underscore grave " +
  "abcdefghijklmnopqrstuvwxyz".split("").join(" ") +
  " braceleft bar braceright asciitilde"
).split(" ");
const HIGH_NAMES = (
  "Euro - quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE - " +
  "Zcaron - - quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe - zcaron Ydieresis"
).split(" ");
const HIGH_UNICODE = [
  0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178,
];
const LATIN_NAMES = (
  "space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot " +
  "hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior " +
  "ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring " +
  "AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex " +
  "Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex " +
  "atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde " +
  "ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis"
).split(" ");

function winAnsiUnicode(code: number): number {
  if (code >= 32 && code <= 126) return code;
  if (code >= 128 && code <= 159) return HIGH_UNICODE[code - 128];
  if (code >= 160 && code <= 255) return code;
  return 0;
}

const GLYPH_UNICODE = new Map<string, string>();
ASCII_NAMES.forEach((name, i) => GLYPH_UNICODE.set(name, String.fromCharCode(32 + i)));
HIGH_NAMES.forEach((name, i) => name !== "-" && GLYPH_UNICODE.set(name, String.fromCharCode(HIGH_UNICODE[i])));
LATIN_NAMES.forEach((name, i) => !GLYPH_UNICODE.has(name) && GLYPH_UNICODE.set(name, String.fromCharCode(160 + i)));
for (const [name, text] of Object.entries({
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", dotlessi: "ı", minus: "−", fraction: "⁄",
  nbspace: " ", sfthyphen: "­", Lslash: "Ł", lslash: "ł", quoteright: "’", quoteleft: "‘",
})) GLYPH_UNICODE.set(name, text);

function glyphNameUnicode(name: string): string {
  const base = name.split(".")[0];
  const known = GLYPH_UNICODE.get(base);
  if (known) return known;
  const uni = /^uni([0-9A-F]{4,})$/i.exec(base);
  if (uni) return String.fromCharCode(...(uni[1].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  const u = /^u([0-9A-F]{4,6})$/i.exec(base);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  return "";
}

const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};

const hexValue = (hex: string) => parseInt(hex || "0", 16);
function utf16(hex: string): string {
  if (hex.length <= 2) return hex ? String.fromCharCode(hexValue(hex)) : "";
  const units: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

/** Reads the bfchar/bfrange sections of a ToUnicode CMap. */
function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(hexValue(m[1]), utf16(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
      const lo = hexValue(m[1]);
      const hi = Math.min(hexValue(m[2]), lo + 0xffff);
      if (m[3].startsWith("[")) {
        [...m[3].matchAll(/<([0-9a-f]*)>/gi)].forEach((item, i) => map.set(lo + i, utf16(item[1])));
        continue;
      }
      const dst = m[3].slice(1, -1);
      const head = dst.slice(0, -4);
      const last = parseInt(dst.slice(-4) || "0", 16);
      for (let code = lo; code <= hi; code++) {
        map.set(code, dst.length <= 4 ? String.fromCharCode(last + code - lo) : utf16(head) + String.fromCharCode(last + code - lo));
      }
    }
  }
  return map;
}

/** Byte lengths allowed by an embedded CMap's codespace ranges. */
function parseCodespace(text: string) {
  const ranges: { length: number; lo: number[]; hi: number[] }[] = [];
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      const bytes = (hex: string) => (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));
      ranges.push({ length: m[1].length / 2, lo: bytes(m[1]), hi: bytes(m[2]) });
    }
  }
  return ranges.sort((a, b) => a.length - b.length);
}

function parseCidMap(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const block of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*(\d+)/gi)) map.set(hexValue(m[1]), Number(m[2]));
  }
  for (const block of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(\d+)/gi)) {
      const lo = hexValue(m[1]);
      for (let c = lo, hi = Math.min(hexValue(m[2]), lo + 0xffff); c <= hi; c++) map.set(c, Number(m[3]) + c - lo);
    }
  }
  return map;
}

/** Standard 14 font for a family/weight/slant. */
export function standardFontName(family: FontFamily, bold: boolean, italic: boolean): string {
  if (family === "serif") return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  const base = family === "mono" ? "Courier" : "Helvetica";
  return bold || italic ? `${base}-${bold ? "Bold" : ""}${italic ? "Oblique" : ""}` : base;
}

function guessStyle(name: string, flags: number, weight: number, italicAngle: number) {
  const n = name.toLowerCase();
  const family: FontFamily =
    /courier|mono|consol|menlo|typewriter/.test(n) || flags & 1 ? "mono"
      : /times|serif(?!.*sans)|georgia|garamond|roman|cambria|book|minion|palatino|baskerville/.test(n) && !/sans/.test(n) ? "serif"
      : flags & 2 && !/sans|arial|helvetica/.test(n) ? "serif"
      : "sans";
  return {
    family,
    bold: /bold|black|heavy|semibold|demi/.test(n) || weight >= 600 || !!(flags & 0x40000),
    italic: /italic|oblique/.test(n) || italicAngle !== 0 || !!(flags & 0x40),
  };
}

export interface FontCache {
  lib: Lib;
  get(value: PDFObject | undefined): FontInfo | null;
  /** Standard font metrics, for unembedded fonts that carry no widths. */
  standard(name: string): PDFFont | undefined;
}

const STANDARD = [
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold",
  "Times-Italic", "Times-BoldItalic", "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
];

export async function createFontCache(lib: Lib, doc: PDFDocument): Promise<FontCache> {
  const scratch = await lib.PDFDocument.create();
  const metrics = new Map<string, PDFFont>();
  for (const name of STANDARD) metrics.set(name, await scratch.embedFont(name));
  const byDict = new Map<PDFDict, FontInfo>();
  let counter = 0;

  const cache: FontCache = {
    lib,
    standard: (name) => metrics.get(name),
    get(value) {
      const ref = value instanceof lib.PDFRef ? value : undefined;
      const dict = doc.context.lookupMaybe(value, lib.PDFDict);
      if (!dict) return null;
      let info = byDict.get(dict);
      if (!info) {
        info = loadFont(cache, doc, dict, ref, ref ? ref.toString() : `d${counter++}`);
        byDict.set(dict, info);
      }
      return info;
    },
  };
  return cache;
}

function loadFont(cache: FontCache, doc: PDFDocument, dict: PDFDict, ref: PDFRef | undefined, id: string): FontInfo {
  const { lib } = cache;
  const N = (k: string) => lib.PDFName.of(k);
  const num = (d: PDFDict | undefined, k: string, fallback = 0) => d?.lookupMaybe(N(k), lib.PDFNumber)?.asNumber() ?? fallback;
  const streamText = (obj: PDFObject | undefined) => {
    const found = obj && doc.context.lookup(obj);
    const stream = found instanceof lib.PDFRawStream ? found : undefined;
    try { return stream ? latin1(lib.decodePDFRawStream(stream).decode()) : ""; } catch { return ""; }
  };

  const subtype = dict.lookupMaybe(N("Subtype"), lib.PDFName)?.asString() ?? "/Type1";
  const type0 = subtype === "/Type0";
  const type3 = subtype === "/Type3";
  const rawName = dict.lookupMaybe(N("BaseFont"), lib.PDFName)?.decodeText() ?? (type3 ? "Type3" : "Unknown");
  const subset = /^[A-Z]{6}\+/.test(rawName);
  const name = rawName.replace(/^[A-Z]{6}\+/, "");

  const descendant = type0 ? dict.lookupMaybe(N("DescendantFonts"), lib.PDFArray)?.lookupMaybe(0, lib.PDFDict) : undefined;
  const descriptor = (descendant ?? dict).lookupMaybe(N("FontDescriptor"), lib.PDFDict);
  const embedded = !!descriptor && ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor.has(N(k)));
  const flags = num(descriptor, "Flags");
  const style = guessStyle(name, flags, num(descriptor, "FontWeight", 400), num(descriptor, "ItalicAngle"));

  // Type3 glyphs live in their own space; everything else is in 1/1000 em.
  const matrix = type3 ? dict.lookupMaybe(N("FontMatrix"), lib.PDFArray)?.asArray().map((v) => (v as { asNumber?: () => number }).asNumber?.() ?? 0) : undefined;
  const unitX = matrix ? matrix[0] || 0.001 : 0.001;
  const unitY = matrix ? matrix[3] || 0.001 : 0.001;
  let ascent = num(descriptor, "Ascent");
  let descent = num(descriptor, "Descent");
  if (!ascent && type3) {
    const bbox = dict.lookupMaybe(N("FontBBox"), lib.PDFArray)?.asArray().map((v) => (v as { asNumber?: () => number }).asNumber?.() ?? 0);
    if (bbox) { descent = bbox[1]; ascent = bbox[3]; }
  }
  ascent = ascent ? Math.abs(ascent * unitY) : 0.8;
  // Some producers (Skia) write a positive descent.
  descent = descent ? -Math.abs(descent * unitY) : -0.2;

  const toUnicode = parseToUnicode(streamText(dict.get(N("ToUnicode"))));
  const used = new Set<number>();

  if (type0) {
    const encoding = dict.get(N("Encoding"));
    const cmapText = encoding instanceof lib.PDFName ? "" : streamText(encoding);
    const codespace = parseCodespace(cmapText);
    const cidMap = cmapText ? parseCidMap(cmapText) : null;
    const widths = new Map<number, number>();
    const dw = num(descendant, "DW", 1000);
    const w = descendant?.lookupMaybe(N("W"), lib.PDFArray)?.asArray() ?? [];
    const n = (o: PDFObject | undefined) => (o instanceof lib.PDFNumber ? o.asNumber() : NaN);
    for (let i = 0; i < w.length; ) {
      const first = n(doc.context.lookup(w[i]));
      const next = doc.context.lookup(w[i + 1]);
      if (next instanceof lib.PDFArray) {
        next.asArray().forEach((v, j) => widths.set(first + j, n(doc.context.lookup(v))));
        i += 2;
      } else {
        const last = n(next);
        const width = n(doc.context.lookup(w[i + 2]));
        for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
        i += 3;
      }
    }
    const reverse = new Map<string, number>();
    for (const [code, text] of toUnicode) if (text && !reverse.has(text)) reverse.set(text, code);
    return {
      id, ref, dict, name, subset, embedded, type3: false, twoByte: true, ...style, ascent, descent, used,
      codeLength(bytes, at) {
        if (!codespace.length) return 2;
        for (const range of codespace) {
          if (at + range.length > bytes.length) continue;
          let inside = true;
          for (let k = 0; k < range.length && inside; k++) inside = bytes[at + k] >= range.lo[k] && bytes[at + k] <= range.hi[k];
          if (inside) return range.length;
        }
        return codespace[0].length;
      },
      width: (code) => (widths.get(cidMap?.get(code) ?? code) ?? dw) / 1000,
      unicode: (code) => toUnicode.get(code) ?? "",
      codeFor: (ch) => reverse.get(ch),
      // Codespace-only CMaps cannot be reversed reliably; only reuse plain 2-byte codes.
      canShow: (code) => codespace.every((r) => r.length === 2) && (subset || !embedded ? used.has(code) : true),
    };
  }

  // Simple fonts: one byte per code.
  const encoding = dict.lookup(N("Encoding"));
  const baseName = encoding instanceof lib.PDFName ? encoding.asString()
    : encoding instanceof lib.PDFDict ? encoding.lookupMaybe(N("BaseEncoding"), lib.PDFName)?.asString() : undefined;
  const differences = new Map<number, string>();
  if (encoding instanceof lib.PDFDict) {
    let code = 0;
    for (const item of encoding.lookupMaybe(N("Differences"), lib.PDFArray)?.asArray() ?? []) {
      const v = doc.context.lookup(item);
      if (v instanceof lib.PDFNumber) code = v.asNumber();
      else if (v instanceof lib.PDFName) differences.set(code++, v.decodeText());
    }
  }
  const standardText = (code: number) => {
    if (baseName === "/StandardEncoding" || (!baseName && !embedded)) {
      if (code === 39) return "’";
      if (code === 96) return "‘";
    }
    const u = winAnsiUnicode(code);
    return u ? String.fromCharCode(u) : "";
  };
  const unicode = (code: number) => {
    const mapped = toUnicode.get(code);
    if (mapped !== undefined) return mapped;
    const diff = differences.get(code);
    return diff !== undefined ? glyphNameUnicode(diff) : standardText(code);
  };

  const firstChar = num(dict, "FirstChar");
  const widthArray = dict.lookupMaybe(N("Widths"), lib.PDFArray)?.asArray().map((v) => {
    const o = doc.context.lookup(v);
    return o instanceof lib.PDFNumber ? o.asNumber() : 0;
  });
  const missing = num(descriptor, "MissingWidth");
  const metric = !widthArray ? cache.standard(standardFontName(style.family, style.bold, style.italic)) : undefined;
  const width = (code: number) => {
    const w = widthArray?.[code - firstChar];
    if (w !== undefined) return w * unitX;
    if (metric) {
      try { return metric.widthOfTextAtSize(unicode(code) || " ", 1); } catch { return 0.5; }
    }
    return (missing || 500) * unitX;
  };

  const reverse = new Map<string, number>();
  for (let code = 0; code < 256; code++) {
    const text = unicode(code);
    if (text && !reverse.has(text)) reverse.set(text, code);
  }
  return {
    id, ref, dict, name, subset, embedded, type3, twoByte: false, ...style, ascent, descent, used,
    codeLength: () => 1,
    width,
    unicode,
    codeFor: (ch) => reverse.get(ch),
    canShow: (code) => !type3 && (!embedded || (subset ? used.has(code) : (widthArray?.[code - firstChar] ?? 0) > 0)),
  };
}
