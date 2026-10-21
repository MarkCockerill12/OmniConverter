import type { PDFDocument, PDFFont, PDFPage } from "@cantoo/pdf-lib";
import { unzlibSync, zipSync } from "fflate";
import type { EditOptions, PdfAnnotation, PdfEdits, PdfPageRef } from "@/lib/formats";
import { pdfImagePlanFor } from "@/lib/compression";
import { pageSpace } from "./pdf-content";

/**
 * PDF editing: page assembly, drawn annotations, form filling, stamps,
 * metadata, encryption and image recompression. Redaction and in-place text
 * edits rewrite the page content itself (see pdf-redact.ts).
 */

type Lib = typeof import("@cantoo/pdf-lib");
const loadLib = () => import("@cantoo/pdf-lib");

export interface PdfFieldInfo {
  name: string;
  kind: "text" | "checkbox" | "choice";
  value: string | boolean;
  choices?: string[];
}

const isPdfBytes = (bytes: Uint8Array) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
const isPng = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50;
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8;

function parseColor(lib: Lib, hex = "#000000") {
  const value = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace("#", "") : "000000";
  const channel = (i: number) => parseInt(value.slice(i, i + 2), 16) / 255;
  return lib.rgb(channel(0), channel(2), channel(4));
}

/** The standard fonts only cover WinAnsi; anything else would throw mid-draw. */
export function safeText(font: PDFFont, text: string) {
  const known = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text.replace(/\t/g, "    ")) out += known.has(ch.codePointAt(0)!) ? ch : "?";
  return out;
}

/** Re-encodes any browser-readable picture as PNG so pdf-lib can embed it. */
async function toEmbeddable(blob: Blob): Promise<{ bytes: Uint8Array; jpeg: boolean }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isJpeg(bytes)) return { bytes, jpeg: true };
  if (isPng(bytes)) return { bytes, jpeg: false };
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return { bytes: new Uint8Array(await png.arrayBuffer()), jpeg: false };
}

async function embedPicture(doc: PDFDocument, blob: Blob) {
  const { bytes, jpeg } = await toEmbeddable(blob);
  return jpeg ? doc.embedJpg(bytes) : doc.embedPng(bytes);
}

/** Opens a PDF, or wraps a picture as a single-page PDF so it can be merged in. */
async function openSource(lib: Lib, file: Blob, password?: string): Promise<PDFDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdfBytes(bytes)) {
    try {
      return await lib.PDFDocument.load(bytes, password ? { password } : {});
    } catch (err) {
      if (/encrypt|password/i.test(String((err as Error)?.message))) {
        throw new Error(
          password ? "That password does not open this PDF." : "This PDF is password-protected. Enter its password in the editor.",
          { cause: err }
        );
      }
      throw err;
    }
  }
  const doc = await lib.PDFDocument.create();
  const image = await embedPicture(doc, file);
  doc.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return doc;
}

async function drawAnnotation(lib: Lib, doc: PDFDocument, page: PDFPage, font: PDFFont, ann: PdfAnnotation) {
  const space = pageSpace(page);
  const color = parseColor(lib, ann.color);
  const rotate = lib.degrees(space.rotation);

  if (ann.type === "text") {
    const size = ann.size ?? 14;
    const lines = safeText(font, ann.text ?? "").split("\n");
    lines.forEach((line, i) => {
      // 0.95em puts the baseline where the editor's 1.2 line-height preview has it.
      const at = space.toUser(ann.x, ann.y + size * 0.95 + i * size * 1.2);
      page.drawText(line, { x: at.x, y: at.y, size, font, color, rotate, opacity: ann.opacity ?? 1 });
    });
    return;
  }

  if (ann.type === "highlight" || ann.type === "rect" || ann.type === "redact") {
    const a = space.toUser(ann.x, ann.y);
    const b = space.toUser(ann.x + ann.width, ann.y + ann.height);
    page.drawRectangle({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      color,
      opacity: ann.type === "redact" ? 1 : ann.opacity ?? (ann.type === "highlight" ? 0.4 : 1),
      // Multiply keeps the text under a highlight fully legible.
      ...(ann.type === "highlight" ? { blendMode: lib.BlendMode.Multiply } : {}),
    });
    return;
  }

  if (ann.type === "ink") {
    for (const stroke of ann.strokes ?? []) {
      for (let i = 1; i < stroke.length; i++) {
        page.drawLine({
          start: space.toUser(stroke[i - 1].x, stroke[i - 1].y),
          end: space.toUser(stroke[i].x, stroke[i].y),
          thickness: ann.strokeWidth ?? 2,
          color,
          opacity: ann.opacity ?? 1,
          lineCap: lib.LineCapStyle.Round,
        });
      }
    }
    return;
  }

  if (ann.type === "image" && ann.image) {
    const image = await embedPicture(doc, ann.image);
    // pdf-lib anchors and rotates a picture about its bottom-left corner.
    const at = space.toUser(ann.x, ann.y + ann.height);
    page.drawImage(image, { x: at.x, y: at.y, width: ann.width, height: ann.height, rotate, opacity: ann.opacity ?? 1 });
  }
}

function drawStamps(lib: Lib, doc: PDFDocument, font: PDFFont, edits: PdfEdits) {
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    const space = pageSpace(page);
    const mark = edits.watermark;
    if (mark?.text.trim()) {
      const text = safeText(font, mark.text);
      const length = font.widthOfTextAtSize(text, mark.size);
      const lean = Math.SQRT1_2; // 45 degrees, rising to the right
      const at = space.toUser(space.width / 2 - (length / 2) * lean, space.height / 2 + (length / 2) * lean);
      page.drawText(text, {
        x: at.x, y: at.y, size: mark.size, font,
        color: parseColor(lib, mark.color),
        opacity: mark.opacity,
        rotate: lib.degrees(space.rotation + 45),
      });
    }
    if (edits.pageNumbers) {
      const label = `${index + 1} / ${pages.length}`;
      const at = space.toUser(space.width / 2 - font.widthOfTextAtSize(label, 9) / 2, space.height - 22);
      page.drawText(label, { x: at.x, y: at.y, size: 9, font, color: lib.rgb(0.35, 0.35, 0.35), rotate: lib.degrees(space.rotation) });
    }
  });
}

function fillForm(lib: Lib, doc: PDFDocument, edits: PdfEdits) {
  if (!edits.fields && !edits.flattenForm) return;
  const form = doc.getForm();
  for (const [name, value] of Object.entries(edits.fields ?? {})) {
    const field = form.getFieldMaybe(name);
    try {
      if (field instanceof lib.PDFTextField) field.setText(String(value));
      else if (field instanceof lib.PDFCheckBox && value) field.check();
      else if (field instanceof lib.PDFCheckBox) field.uncheck();
      else if (field instanceof lib.PDFDropdown || field instanceof lib.PDFRadioGroup) field.select(String(value));
    } catch {
      /* a value the field rejects (too long, not an option) is left as it was */
    }
  }
  if (edits.flattenForm) form.flatten();
}

function applyMetadata(lib: Lib, doc: PDFDocument, edits: PdfEdits) {
  if (edits.stripMetadata) {
    doc.setTitle("");
    doc.setAuthor("");
    doc.setSubject("");
    doc.setKeywords([]);
    doc.setCreator("");
    doc.setProducer("");
    doc.catalog.delete(lib.PDFName.of("Metadata")); // the XMP packet repeats all of it
    return;
  }
  const meta = edits.metadata;
  if (!meta) return;
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) doc.setKeywords(meta.keywords.split(",").map((k) => k.trim()).filter(Boolean));
}

/**
 * Re-encodes embedded photographs as smaller JPEGs. Only plain 8-bit RGB/grey
 * pictures without masks are touched; anything unusual is left exactly as it is.
 */
async function recompressImages(lib: Lib, doc: PDFDocument, plan: { quality: number; maxEdge: number }) {
  const { PDFName, PDFNumber, PDFRawStream, PDFArray } = lib;
  const name = (key: string) => PDFName.of(key);

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.lookup(name("Subtype")) !== name("Image")) continue;
    if (dict.has(name("SMask")) || dict.has(name("Mask")) || dict.has(name("ImageMask")) || dict.has(name("Decode"))) continue;
    if (dict.has(name("DecodeParms"))) continue;

    const colorSpace = dict.lookup(name("ColorSpace"));
    const channels = colorSpace === name("DeviceRGB") ? 3 : colorSpace === name("DeviceGray") ? 1 : 0;
    if (!channels) continue;

    let filter = dict.lookup(name("Filter"));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.lookup(0) : undefined;
    const width = dict.lookupMaybe(name("Width"), PDFNumber)?.asNumber() ?? 0;
    const height = dict.lookupMaybe(name("Height"), PDFNumber)?.asNumber() ?? 0;
    if (!width || !height) continue;

    let source: CanvasImageSource;
    try {
      if (filter === name("DCTDecode")) {
        source = await createImageBitmap(new Blob([object.contents as BlobPart], { type: "image/jpeg" }));
      } else if (filter === name("FlateDecode") && dict.lookupMaybe(name("BitsPerComponent"), PDFNumber)?.asNumber() === 8) {
        const raw = unzlibSync(object.contents);
        if (raw.length < width * height * channels) continue;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let i = 0, o = 0; o < pixels.length; i += channels, o += 4) {
          pixels[o] = raw[i];
          pixels[o + 1] = raw[channels === 3 ? i + 1 : i];
          pixels[o + 2] = raw[channels === 3 ? i + 2 : i];
          pixels[o + 3] = 255;
        }
        source = await createImageBitmap(new ImageData(pixels, width, height));
      } else {
        continue;
      }
    } catch {
      continue; // CMYK or progressive oddities the browser refuses
    }

    const scale = Math.min(1, plan.maxEdge / Math.max(width, height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    (source as ImageBitmap).close();

    const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: plan.quality })).arrayBuffer());
    if (jpeg.length >= object.contents.length * 0.95) continue; // not worth the generation loss

    dict.set(name("Width"), PDFNumber.of(canvas.width));
    dict.set(name("Height"), PDFNumber.of(canvas.height));
    dict.set(name("ColorSpace"), name("DeviceRGB"));
    dict.set(name("BitsPerComponent"), PDFNumber.of(8));
    dict.set(name("Filter"), name("DCTDecode"));
    doc.context.assign(ref, PDFRawStream.of(dict, jpeg));
  }
}

/** Builds the output document's page list from the edit description. */
async function assemble(lib: Lib, file: Blob, edits: PdfEdits): Promise<{ doc: PDFDocument; keys: string[]; refs: PdfPageRef[]; inPlace: boolean }> {
  const primary = await openSource(lib, file, edits.openPassword);
  const attachments = edits.attachments ?? [];
  const identity = (): PdfPageRef[] =>
    primary.getPageIndices().map((index) => ({ key: `0:${index}`, source: 0, index, rotate: 0 }));
  const refs = edits.pages ?? identity();
  if (refs.length === 0) throw new Error("Every page was removed; there is nothing to save.");

  // Nothing but deletions on the original: edit it in place so its form,
  // bookmarks and links all survive.
  const inPlace = refs.every((ref, i) => ref.source === 0 && (i === 0 || ref.index > refs[i - 1].index));
  if (inPlace) {
    const keep = new Set(refs.map((ref) => ref.index));
    for (let i = primary.getPageCount() - 1; i >= 0; i--) if (!keep.has(i)) primary.removePage(i);
    return { doc: primary, keys: refs.map((ref) => ref.key), refs, inPlace };
  }

  // Reordering or merging copies pages into a fresh document. Interactive form
  // fields and the outline belong to the document, not its pages, and do not follow.
  const out = await lib.PDFDocument.create();
  const sources = new Map<number, PDFDocument>([[0, primary]]);
  for (const ref of refs) {
    if (!sources.has(ref.source)) {
      const attachment = attachments[ref.source - 1];
      if (!attachment) throw new Error("A merged file is missing; add it again in the editor.");
      sources.set(ref.source, await openSource(lib, attachment));
    }
    const [page] = await out.copyPages(sources.get(ref.source)!, [ref.index]);
    out.addPage(page);
  }
  for (const copy of [
    () => { const v = primary.getTitle(); if (v) out.setTitle(v); },
    () => { const v = primary.getAuthor(); if (v) out.setAuthor(v); },
    () => { const v = primary.getSubject(); if (v) out.setSubject(v); },
  ]) {
    try { copy(); } catch { /* unreadable Info entry */ }
  }
  return { doc: out, keys: refs.map((ref) => ref.key), refs, inPlace };
}

async function finish(doc: PDFDocument, edits: PdfEdits): Promise<Uint8Array> {
  if (edits.protectPassword) {
    doc.encrypt({
      userPassword: edits.protectPassword,
      ownerPassword: edits.protectPassword,
      permissions: { printing: "highResolution", copying: true, modifying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
    });
  }
  return doc.save();
}

/**
 * Applies every edit and returns the new PDF, or a ZIP of single-page PDFs
 * when splitting was requested.
 */
export async function editPdf(file: Blob, options: EditOptions = {}): Promise<Blob> {
  const lib = await loadLib();
  const edits = options.pdf ?? {};
  const { doc, keys, refs, inPlace } = await assemble(lib, file, edits);

  // Before form filling: a redaction deletes the fields it touches.
  const { applyContentEdits, sweepUnreachable } = await import("./pdf-redact");
  const rewrote = await applyContentEdits(lib, doc, keys, edits.annotations ?? []);
  if (inPlace) fillForm(lib, doc, edits);

  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const ann of edits.annotations ?? []) {
    if (ann.type === "edit") continue;
    const index = keys.indexOf(ann.page);
    if (index !== -1) await drawAnnotation(lib, doc, pages[index], font, ann);
  }
  pages.forEach((page, i) => {
    if (refs[i].rotate) page.setRotation(lib.degrees((page.getRotation().angle + refs[i].rotate) % 360));
  });
  drawStamps(lib, doc, font, edits);
  applyMetadata(lib, doc, edits);

  // The replaced content streams and images are still in the file until
  // nothing points at them: drop them so redacted data cannot be recovered.
  if (rewrote) {
    await doc.flush();
    sweepUnreachable(lib, doc);
  }

  const plan = options.compression ? pdfImagePlanFor(options.compression) : null;
  if (plan) await recompressImages(lib, doc, plan);

  if (!edits.split) return new Blob([(await finish(doc, edits)) as BlobPart], { type: "application/pdf" });

  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < pages.length; i++) {
    const single = await lib.PDFDocument.create();
    const [page] = await single.copyPages(doc, [i]);
    single.addPage(page);
    entries[`page_${String(i + 1).padStart(3, "0")}.pdf`] = await finish(single, edits);
  }
  return new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: "application/zip" });
}

/** True when the options ask for any change to the PDF itself. */
export function hasPdfEdits(options: EditOptions) {
  return !!options.pdf && Object.values(options.pdf).some((v) => v !== undefined && v !== false);
}

/** Lists the fillable form fields of a PDF with their current values. */
export async function listPdfFields(file: Blob, password?: string): Promise<PdfFieldInfo[]> {
  const lib = await loadLib();
  const doc = await openSource(lib, file, password);
  const fields: PdfFieldInfo[] = [];
  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    try {
      if (field instanceof lib.PDFTextField) fields.push({ name, kind: "text", value: field.getText() ?? "" });
      else if (field instanceof lib.PDFCheckBox) fields.push({ name, kind: "checkbox", value: field.isChecked() });
      else if (field instanceof lib.PDFDropdown) fields.push({ name, kind: "choice", value: field.getSelected()[0] ?? "", choices: field.getOptions() });
      else if (field instanceof lib.PDFRadioGroup) fields.push({ name, kind: "choice", value: field.getSelected() ?? "", choices: field.getOptions() });
    } catch {
      /* malformed field: not offered for editing */
    }
  }
  return fields;
}

/** Turns a picture into a one-page PDF so it previews and merges like any other source. */
export async function wrapAsPdf(file: File): Promise<File> {
  if (isPdfBytes(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) return file;
  const doc = await openSource(await loadLib(), file);
  return new File([(await doc.save()) as BlobPart], `${file.name.replace(/\.[^.]+$/, "")}.pdf`, { type: "application/pdf" });
}
