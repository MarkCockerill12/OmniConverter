import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Extensions the 3D Forge can open (archives included). */
const MODEL_EXT_RE = /\.(glb|gltf|obj|stl|fbx|dae|zip|szs|mdl0)$/i;

export function is3DFile(fileName: string) {
  return MODEL_EXT_RE.test(fileName);
}

export function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

export function stripExtension(fileName: string) {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
}

/** Triggers a browser download for a Blob and releases the object URL afterwards. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in Safari/Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Rasterises a vector image (SVG) to a raster format using the browser's own
 * renderer. FFmpeg.wasm ships no SVG decoder, so this covers the gap without
 * pulling in an extra dependency.
 */
export async function rasterizeVector(
  file: File,
  targetFormat: string,
  options?: { resolution?: string; crop?: { x: number; y: number; width: number; height: number } }
): Promise<Blob> {
  // A blob URL with no MIME type will not decode as SVG, and files coming from
  // drag-and-drop or a re-wrapped Blob often have an empty type.
  const source = file.type ? file : new Blob([await file.arrayBuffer()], { type: "image/svg+xml" });
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not decode the vector image."));
      img.src = url;
    });

    let width = img.naturalWidth || 1024;
    let height = img.naturalHeight || 1024;
    if (options?.resolution) {
      const [w, h] = options.resolution.split("x").map(Number);
      if (w && h) {
        width = w;
        height = h;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = options?.crop?.width || width;
    canvas.height = options?.crop?.height || height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");

    if (options?.crop) {
      const { x, y, width: cw, height: ch } = options.crop;
      ctx.drawImage(img, x, y, cw, ch, 0, 0, cw, ch);
    } else {
      ctx.drawImage(img, 0, 0, width, height);
    }

    const mime = targetFormat === "jpg" || targetFormat === "jpeg"
      ? "image/jpeg"
      : targetFormat === "webp"
        ? "image/webp"
        : "image/png";

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.95));
    if (!blob) throw new Error("Rasterisation failed.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
