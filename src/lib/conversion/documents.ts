import { zipSync } from "fflate";
import type { EditOptions } from "@/lib/formats";
import { CANVAS_MIME } from "./native";

/**
 * Document conversions, all client-side.
 * PDF pages are rasterised (or read as text) with pdf.js; images are packed
 * into a PDF by a small writer built on canvas JPEG output — no extra library.
 */

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  // Bundled worker: keeps everything same-origin, which the app's COEP requires.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  return pdfjs;
}

async function openPdf(file: File) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  return { doc: await task.promise, task };
}

/** Extracts the full text layer of a PDF. */
export async function pdfToText(file: File): Promise<Blob> {
  const { doc, task } = await openPdf(file);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(`--- Page ${i} ---\n${text}`);
    page.cleanup();
  }
  await task.destroy();
  return new Blob([pages.join("\n\n")], { type: "text/plain;charset=utf-8" });
}

/**
 * Rasterises every page. A single-page PDF yields the image directly; multi-page
 * documents come back as a ZIP so one job still maps to one download.
 */
export async function pdfToImages(file: File, target: string, options: EditOptions = {}): Promise<Blob> {
  const mime = CANVAS_MIME[target.toLowerCase()];
  if (!mime) throw new Error(`PDF pages cannot be written as ${target.toUpperCase()}.`);

  const { doc, task } = await openPdf(file);
  const quality = (options.quality ?? 92) / 100;
  const scale = options.scalePercent ? options.scalePercent / 100 : 2; // 2x ≈ 144 DPI
  const rendered: { name: string; data: Uint8Array }[] = [];

  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable.");
      // JPEG has no alpha: paint the page background first.
      if (mime === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
      if (!blob) throw new Error(`Page ${i} could not be encoded.`);
      rendered.push({
        name: `page_${String(i).padStart(3, "0")}.${target.toLowerCase()}`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  if (rendered.length === 0) throw new Error("The PDF contains no pages.");
  if (rendered.length === 1) return new Blob([rendered[0].data as BlobPart], { type: mime });

  const entries: Record<string, Uint8Array> = {};
  for (const page of rendered) entries[page.name] = page.data;
  return new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: "application/zip" });
}

/** Minimal single-image PDF writer: one page, JPEG (DCTDecode) payload. */
export async function imageToPdf(file: File, options: EditOptions = {}): Promise<Blob> {
  const { convertImageNative } = await import("./native");
  const jpeg = await convertImageNative(file, "jpg", options);
  const bytes = new Uint8Array(await jpeg.arrayBuffer());

  // Read the JPEG's SOF marker for the true pixel dimensions.
  let width = 0;
  let height = 0;
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (bytes[i + 5] << 8) | bytes[i + 6];
      width = (bytes[i + 7] << 8) | bytes[i + 8];
      break;
    }
    i += 2 + length;
  }
  if (!width || !height) throw new Error("Could not measure the image.");

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let position = 0;
  const push = (chunk: Uint8Array | string) => {
    const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    parts.push(data);
    position += data.length;
  };
  const startObject = () => offsets.push(position);

  push("%PDF-1.4\n");
  startObject();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObject();
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  startObject();
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  startObject();
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
  push(bytes);
  push("\nendstream\nendobj\n");
  const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  startObject();
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

  const xrefPosition = position;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);

  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
