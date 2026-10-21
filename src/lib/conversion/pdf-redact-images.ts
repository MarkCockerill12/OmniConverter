import type { PDFDict, PDFDocument, PDFObject, PDFRawStream, PDFRef } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { apply, boundsOf, invert, type Matrix, type Rect } from "./pdf-content";
import type { Op, Operand } from "./pdf-syntax";

/**
 * Redacting pictures: the pixels under a box are overwritten in a copy of the
 * image (and of its soft or stencil mask), whatever the image's encoding.
 */

type Lib = typeof import("@cantoo/pdf-lib");

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

interface Pixels { width: number; height: number; data: Uint8ClampedArray }

const INLINE_KEYS: Record<string, string> = { BPC: "BitsPerComponent", CS: "ColorSpace", D: "Decode", DP: "DecodeParms", F: "Filter", H: "Height", IM: "ImageMask", I: "Interpolate", W: "Width" };
const INLINE_NAMES: Record<string, string> = {
  G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", I: "Indexed",
  AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", Fl: "FlateDecode", RL: "RunLengthDecode", CCF: "CCITTFaxDecode", DCT: "DCTDecode",
};

function toPdfObject(lib: Lib, doc: PDFDocument, o: Operand, resources?: PDFDict, key?: string): PDFObject {
  if (typeof o === "number") return lib.PDFNumber.of(o);
  if (typeof o === "boolean") return o ? lib.PDFBool.True : lib.PDFBool.False;
  if (o === null) return lib.PDFNull;
  if (Array.isArray(o)) return doc.context.obj(o.map((v) => toPdfObject(lib, doc, v, resources)));
  if (o.t === "name") {
    const named = resources?.lookupMaybe(lib.PDFName.of("ColorSpace"), lib.PDFDict)?.get(lib.PDFName.of(o.v));
    if (key === "ColorSpace" && named && !INLINE_NAMES[o.v]) return named;
    return lib.PDFName.of(INLINE_NAMES[o.v] ?? o.v);
  }
  if (o.t === "str") return lib.PDFHexString.of(hex(Array.from(o.v)));
  const dict = doc.context.obj({});
  for (const [k, v] of o.v) dict.set(lib.PDFName.of(INLINE_KEYS[k] ?? k), toPdfObject(lib, doc, v, resources, INLINE_KEYS[k] ?? k));
  return dict;
}

/** Turns BI ... EI into an equivalent image XObject stream. */
export function inlineToStream(lib: Lib, doc: PDFDocument, op: Op, resources?: PDFDict): PDFRawStream {
  const dict = doc.context.obj({ Type: "XObject", Subtype: "Image" });
  for (const [k, v] of op.image!.dict) {
    const key = INLINE_KEYS[k] ?? k;
    dict.set(lib.PDFName.of(key), toPdfObject(lib, doc, v, resources, key));
  }
  return lib.PDFRawStream.of(dict, op.image!.data);
}

/**
 * Decodes any image the PDF can hold (JBIG2, CCITT, JPX, Indexed, CMYK, 16-bit…)
 * by letting pdf.js draw it alone on a page exactly its pixel size.
 */
async function decodeImage(lib: Lib, doc: PDFDocument, stream: PDFRawStream): Promise<Pixels> {
  const N = lib.PDFName.of;
  const width = stream.dict.lookupMaybe(N("Width"), lib.PDFNumber)?.asNumber() ?? 0;
  const height = stream.dict.lookupMaybe(N("Height"), lib.PDFNumber)?.asNumber() ?? 0;
  if (!width || !height) throw new Error("image without dimensions");
  const tmp = await lib.PDFDocument.create();
  const copy = lib.PDFObjectCopier.for(doc.context, tmp.context).copy(stream) as PDFRawStream;
  copy.dict.delete(N("SMask"));
  copy.dict.delete(N("Mask"));
  const page = tmp.addPage([width, height]);
  page.node.setXObject(N("Im0"), tmp.context.register(copy));
  page.pushOperators(lib.pushGraphicsState(), lib.concatTransformationMatrix(width, 0, 0, height, 0, 0), lib.drawObject("Im0"), lib.popGraphicsState());
  const bytes = await tmp.save({ useObjectStreams: false });

  const { openPdf } = await import("./documents");
  const { doc: shown, task } = await openPdf(new Blob([bytes as BlobPart]));
  try {
    const p = await shown.getPage(1);
    const viewport = p.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    await p.render({ canvas, canvasContext: ctx, viewport } as never).promise;
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  } finally {
    await task.destroy();
  }
}

/** Pixel rectangles of an image (drawn through `ctm`) that fall under the boxes. */
function pixelRegions(ctm: Matrix, rects: Rect[], width: number, height: number) {
  const inv = invert(ctm);
  if (!inv) return [];
  const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const r of rects) {
    const uv = boundsOf([
      ...apply(inv, r.x, r.y), ...apply(inv, r.x + r.width, r.y),
      ...apply(inv, r.x + r.width, r.y + r.height), ...apply(inv, r.x, r.y + r.height),
    ]);
    const u0 = Math.max(0, uv.x), u1 = Math.min(1, uv.x + uv.width);
    const v0 = Math.max(0, uv.y), v1 = Math.min(1, uv.y + uv.height);
    if (u1 <= u0 || v1 <= v0) continue;
    // Image rows run top-down: row 0 sits at v = 1.
    out.push({ x0: Math.floor(u0 * width), x1: Math.ceil(u1 * width), y0: Math.floor((1 - v1) * height), y1: Math.ceil((1 - v0) * height) });
  }
  return out;
}

function paint(px: Pixels, regions: ReturnType<typeof pixelRegions>, rgb: [number, number, number]) {
  for (const r of regions) {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = (y * px.width + x) * 4;
        px.data[i] = rgb[0]; px.data[i + 1] = rgb[1]; px.data[i + 2] = rgb[2]; px.data[i + 3] = 255;
      }
    }
  }
}

async function encodeJpeg(px: Pixels) {
  const canvas = new OffscreenCanvas(px.width, px.height);
  canvas.getContext("2d")!.putImageData(new ImageData(px.data as unknown as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
}

function packBits(px: Pixels, bit: (i: number) => number) {
  const row = Math.ceil(px.width / 8);
  const out = new Uint8Array(row * px.height);
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) if (bit((y * px.width + x) * 4)) out[y * row + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

/** A copy of an image stream with the redacted pixels overwritten. */
export async function redactImage(lib: Lib, doc: PDFDocument, stream: PDFRawStream, ctm: Matrix, rects: Rect[], color: [number, number, number]): Promise<PDFRef | null> {
  const N = lib.PDFName.of;
  const dict = stream.dict;
  const width = dict.lookupMaybe(N("Width"), lib.PDFNumber)?.asNumber() ?? 0;
  const height = dict.lookupMaybe(N("Height"), lib.PDFNumber)?.asNumber() ?? 0;
  const regions = pixelRegions(ctm, rects, width, height);
  if (!regions.length) return null;

  const mask = dict.lookup(N("ImageMask")) === lib.PDFBool.True;
  const bpc = dict.lookupMaybe(N("BitsPerComponent"), lib.PDFNumber)?.asNumber() ?? 8;
  let filter = dict.lookup(N("Filter"));
  if (filter instanceof lib.PDFArray) filter = filter.lookup(filter.size() - 1);
  const wasJpeg = filter === N("DCTDecode");

  let px: Pixels;
  try {
    px = await decodeImage(lib, doc, stream);
  } catch {
    // Undecodable: blank the whole picture rather than leave its data behind.
    px = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    paint(px, [{ x0: 0, y0: 0, x1: width, y1: height }], mask ? [255, 255, 255] : color);
  }

  const next = dict.clone(doc.context);
  for (const key of ["DecodeParms", "Length", "Filter"]) next.delete(N(key));
  let contents: Uint8Array;
  if (mask) {
    // A stencil paints where it is dark; redacted samples become "do not paint".
    paint(px, regions, [255, 255, 255]);
    const decode = dict.lookupMaybe(N("Decode"), lib.PDFArray);
    const inverted = (decode?.lookupMaybe(0, lib.PDFNumber)?.asNumber() ?? 0) === 1;
    contents = zlibSync(packBits(px, (i) => ((px.data[i] < 128) === inverted ? 1 : 0)));
    next.set(N("BitsPerComponent"), lib.PDFNumber.of(1));
    next.set(N("Filter"), N("FlateDecode"));
  } else {
    paint(px, regions, color);
    next.delete(N("Decode"));
    if (dict.lookup(N("Mask")) instanceof lib.PDFArray) next.delete(N("Mask")); // colour keys refer to the old samples
    let gray = true;
    for (let i = 0; i < px.data.length && gray; i += 4) gray = px.data[i] === px.data[i + 1] && px.data[i] === px.data[i + 2];
    if (wasJpeg) {
      contents = await encodeJpeg(px);
      next.set(N("ColorSpace"), N("DeviceRGB"));
      next.set(N("BitsPerComponent"), lib.PDFNumber.of(8));
      next.set(N("Filter"), N("DCTDecode"));
    } else if (bpc === 1 && gray) {
      contents = zlibSync(packBits(px, (i) => (px.data[i] >= 128 ? 1 : 0)));
      next.set(N("ColorSpace"), N("DeviceGray"));
      next.set(N("BitsPerComponent"), lib.PDFNumber.of(1));
      next.set(N("Filter"), N("FlateDecode"));
    } else {
      const channels = gray ? 1 : 3;
      const raw = new Uint8Array(width * height * channels);
      for (let i = 0, o = 0; o < raw.length; i += 4) for (let c = 0; c < channels; c++) raw[o++] = px.data[i + c];
      contents = zlibSync(raw);
      next.set(N("ColorSpace"), N(gray ? "DeviceGray" : "DeviceRGB"));
      next.set(N("BitsPerComponent"), lib.PDFNumber.of(8));
      next.set(N("Filter"), N("FlateDecode"));
    }
    // Soft and stencil masks carry shape too (a scanned signature lives in its mask).
    for (const key of ["SMask", "Mask"]) {
      const sub = dict.has(N(key)) ? doc.context.lookup(dict.get(N(key))) : undefined;
      if (!(sub instanceof lib.PDFRawStream)) continue;
      const subRef = await redactImage(lib, doc, sub, ctm, rects, key === "SMask" ? [255, 255, 255] : color);
      if (subRef) next.set(N(key), subRef);
    }
  }
  return doc.context.register(lib.PDFRawStream.of(next, contents));
}
