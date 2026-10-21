/**
 * PDF content-stream syntax: a lexer that keeps every operator's byte span
 * (so untouched operators are written back byte for byte) and a serializer
 * for the operators that are rebuilt.
 */

export type Operand = number | boolean | null | PdfName | PdfString | PdfDictValue | Operand[];
export interface PdfName { t: "name"; v: string }
export interface PdfString { t: "str"; v: Uint8Array }
export interface PdfDictValue { t: "dict"; v: Map<string, Operand> }
export interface Op {
  op: string;
  args: Operand[];
  start: number;
  end: number;
  /** BI ... EI: the image's parameters and its raw data. */
  image?: { dict: Map<string, Operand>; data: Uint8Array };
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);

export const isName = (o: Operand | undefined): o is PdfName => !!o && typeof o === "object" && !Array.isArray(o) && o.t === "name";
export const isStr = (o: Operand | undefined): o is PdfString => !!o && typeof o === "object" && !Array.isArray(o) && o.t === "str";
export const isDict = (o: Operand | undefined): o is PdfDictValue => !!o && typeof o === "object" && !Array.isArray(o) && o.t === "dict";
export const asNum = (o: Operand | undefined) => (typeof o === "number" ? o : 0);
const isKw = (o: unknown): o is { kw: string } => typeof o === "object" && o !== null && "kw" in o;

export function parseContent(bytes: Uint8Array): Op[] {
  const len = bytes.length;
  let pos = 0;
  const ops: Op[] = [];

  const skipWs = () => {
    while (pos < len) {
      const c = bytes[pos];
      if (WS.has(c)) pos++;
      else if (c === 37) { while (pos < len && bytes[pos] !== 10 && bytes[pos] !== 13) pos++; }
      else break;
    }
  };
  const keyword = () => {
    const from = pos;
    while (pos < len && isRegular(bytes[pos])) pos++;
    return String.fromCharCode(...bytes.subarray(from, pos));
  };

  // Returns an operand, a keyword ({ kw }), or undefined for a stray byte.
  const read = (): Operand | { kw: string } | undefined => {
    const c = bytes[pos];
    if (c === 40) {
      pos++;
      const out: number[] = [];
      let depth = 1;
      while (pos < len) {
        const b = bytes[pos++];
        if (b === 92) {
          const e = bytes[pos++];
          const simple: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
          if (simple[e] !== undefined) out.push(simple[e]);
          else if (e >= 48 && e <= 55) {
            let v = e - 48;
            for (let k = 0; k < 2 && bytes[pos] >= 48 && bytes[pos] <= 55; k++) v = v * 8 + bytes[pos++] - 48;
            out.push(v & 255);
          } else if (e === 13) { if (bytes[pos] === 10) pos++; }
          else if (e !== 10) out.push(e);
        } else if (b === 40) { depth++; out.push(b); }
        else if (b === 41) { if (--depth === 0) break; out.push(b); }
        else out.push(b);
      }
      return { t: "str", v: Uint8Array.from(out) };
    }
    if (c === 60 && bytes[pos + 1] === 60) {
      pos += 2;
      const map = new Map<string, Operand>();
      for (;;) {
        skipWs();
        if (pos >= len) break;
        if (bytes[pos] === 62 && bytes[pos + 1] === 62) { pos += 2; break; }
        const key = read();
        skipWs();
        const value = read();
        if (isName(key as Operand) && value !== undefined && !isKw(value)) map.set((key as PdfName).v, value as Operand);
      }
      return { t: "dict", v: map };
    }
    if (c === 60) {
      pos++;
      let hex = "";
      while (pos < len && bytes[pos] !== 62) {
        const ch = String.fromCharCode(bytes[pos++]);
        if (/[0-9a-f]/i.test(ch)) hex += ch;
      }
      pos++;
      if (hex.length % 2) hex += "0";
      return { t: "str", v: Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)) };
    }
    if (c === 91) {
      pos++;
      const items: Operand[] = [];
      for (;;) {
        skipWs();
        if (pos >= len) break;
        if (bytes[pos] === 93) { pos++; break; }
        const item = read();
        if (item === undefined) continue;
        if (isKw(item)) items.push(null);
        else items.push(item as Operand);
      }
      return items;
    }
    if (c === 47) {
      pos++;
      const raw = keyword();
      return { t: "name", v: raw.replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const word = keyword();
      const n = parseFloat(word);
      return Number.isFinite(n) ? n : 0;
    }
    if (!isRegular(c)) { pos++; return undefined; }
    const word = keyword();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { kw: word };
  };

  let args: Operand[] = [];
  let argStart = -1;
  while (true) {
    skipWs();
    if (pos >= len) break;
    const start = pos;
    const token = read();
    if (token === undefined) continue;
    if (!isKw(token)) {
      if (argStart < 0) argStart = start;
      args.push(token as Operand);
      continue;
    }
    if (token.kw === "BI") {
      const dict = new Map<string, Operand>();
      for (;;) {
        skipWs();
        if (pos >= len) break;
        const key = read();
        if (isKw(key)) break; // ID
        skipWs();
        const value = read();
        if (isName(key as Operand) && value !== undefined && !isKw(value)) dict.set((key as PdfName).v, value as Operand);
      }
      pos++; // the single whitespace after ID
      const dataStart = pos;
      const filtered = dict.has("F") || dict.has("Filter");
      if (!filtered) {
        const w = asNum(dict.get("W") ?? dict.get("Width"));
        const h = asNum(dict.get("H") ?? dict.get("Height"));
        const mask = dict.get("IM") === true || dict.get("ImageMask") === true;
        const cs = dict.get("CS") ?? dict.get("ColorSpace");
        const csName = isName(cs) ? cs.v : "";
        const comps = mask ? 1 : /^(RGB|DeviceRGB|CalRGB)$/.test(csName) ? 3 : /^(CMYK|DeviceCMYK)$/.test(csName) ? 4 : 1;
        const bpc = asNum(dict.get("BPC") ?? dict.get("BitsPerComponent")) || (mask ? 1 : 8);
        pos = Math.min(len, dataStart + Math.ceil((w * comps * bpc) / 8) * h);
      }
      let end = pos;
      while (end + 1 < len && !(bytes[end] === 69 && bytes[end + 1] === 73 && WS.has(bytes[end - 1]) && (end + 2 >= len || !isRegular(bytes[end + 2])))) end++;
      const data = bytes.slice(dataStart, Math.max(dataStart, end - 1));
      pos = Math.min(len, end + 2);
      ops.push({ op: "BI", args: [], start, end: pos, image: { dict, data } });
      args = [];
      argStart = -1;
      continue;
    }
    ops.push({ op: token.kw, args, start: argStart >= 0 ? argStart : start, end: pos });
    args = [];
    argStart = -1;
  }
  return ops;
}

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function serialize(o: Operand): string {
  if (typeof o === "number") return fmt(o);
  if (typeof o === "boolean") return String(o);
  if (o === null) return "null";
  if (Array.isArray(o)) return `[${o.map(serialize).join(" ")}]`;
  if (o.t === "name") {
    return "/" + Array.from(o.v, (ch) => {
      const c = ch.charCodeAt(0);
      return c < 33 || c > 126 || DELIM.has(c) || c === 35 ? `#${c.toString(16).padStart(2, "0")}` : ch;
    }).join("");
  }
  if (o.t === "str") return `<${hex(o.v)}>`;
  return `<<${[...o.v].map(([k, v]) => `${serialize({ t: "name", v: k })} ${serialize(v)}`).join(" ")}>>`;
}
