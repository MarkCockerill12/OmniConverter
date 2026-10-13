import type { EditOptions } from "@/lib/formats";
import { colorBitsFor } from "@/lib/compression";

/**
 * Native browser conversions — canvas and WebAudio only.
 *
 * These paths need no WebAssembly at all, so an image or frame grab completes
 * in milliseconds instead of waiting on the ~30 MB FFmpeg core.
 */

export const CANVAS_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Decodes any browser-readable image (including SVG) into an <img>. */
async function loadImage(file: Blob, fallbackMime?: string): Promise<HTMLImageElement> {
  // A blob URL with no MIME type will not decode as SVG.
  const source = file.type ? file : new Blob([await file.arrayBuffer()], { type: fallbackMime || "image/png" });
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The browser could not decode this image."));
      img.src = url;
    });
    await img.decode().catch(() => undefined);
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Encoding failed."))), mime, quality)
  );
}

/** Number of clockwise quarter turns requested, 0-3. */
export function quarterTurns(options: EditOptions) {
  return ((Math.round((options.rotate ?? 0) / 90) % 4) + 4) % 4;
}

/** The colour adjustments as a CSS/canvas filter string ("none" when untouched). */
export function cssFilterFor(options: EditOptions) {
  const parts: string[] = [];
  if (options.brightness !== undefined && options.brightness !== 100) parts.push(`brightness(${options.brightness}%)`);
  if (options.contrast !== undefined && options.contrast !== 100) parts.push(`contrast(${options.contrast}%)`);
  if (options.saturation !== undefined && options.saturation !== 100) parts.push(`saturate(${options.saturation}%)`);
  if (options.grayscale) parts.push("grayscale(100%)");
  if (options.blur) parts.push(`blur(${options.blur}px)`);
  return parts.length ? parts.join(" ") : "none";
}

/** Rounds every colour channel to `bits` bits so the PNG deflates better. */
function reduceColorDepth(canvas: HTMLCanvasElement, bits: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx || bits >= 8) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const steps = (1 << bits) - 1;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round((Math.round((i / 255) * steps) / steps) * 255);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  ctx.putImageData(image, 0, 0);
}

/** Applies crop, rotation, flips and colour filters, then resolution or percentage scaling. */
function drawToCanvas(img: CanvasImageSource, natural: { width: number; height: number }, options: EditOptions = {}) {
  const crop = options.crop;
  const turns = quarterTurns(options);
  const sideways = turns % 2 === 1;
  // Sizes below describe the picture after rotation.
  const sourceW = sideways ? crop?.height || natural.height : crop?.width || natural.width;
  const sourceH = sideways ? crop?.width || natural.width : crop?.height || natural.height;

  let targetW = sourceW;
  let targetH = sourceH;
  if (options.resolution) {
    const [w, h] = options.resolution.split("x").map(Number);
    // A negative component (e.g. "480x-2") means "keep the aspect ratio".
    if (w > 0 && h > 0) {
      targetW = w;
      targetH = h;
    } else if (w > 0) {
      targetW = w;
      targetH = Math.round((sourceH * w) / sourceW);
    } else if (h > 0) {
      targetH = h;
      targetW = Math.round((sourceW * h) / sourceH);
    }
  } else if (options.scalePercent && options.scalePercent !== 100) {
    targetW = Math.max(1, Math.round(sourceW * (options.scalePercent / 100)));
    targetH = Math.max(1, Math.round(sourceH * (options.scalePercent / 100)));
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(targetW));
  canvas.height = Math.max(1, Math.round(targetH));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  ctx.imageSmoothingQuality = "high";
  ctx.filter = cssFilterFor(options);

  // Draw centred so rotation and mirroring pivot on the middle of the frame.
  const drawW = sideways ? canvas.height : canvas.width;
  const drawH = sideways ? canvas.width : canvas.height;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(options.flipH ? -1 : 1, options.flipV ? -1 : 1);
  ctx.rotate((turns * Math.PI) / 2);
  if (crop) {
    ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, -drawW / 2, -drawH / 2, drawW, drawH);
  } else {
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  return canvas;
}

/** Image -> image (PNG/JPG/WEBP) without touching FFmpeg. Also covers SVG input. */
export async function convertImageNative(file: File, target: string, options: EditOptions = {}): Promise<Blob> {
  const mime = CANVAS_MIME[target.toLowerCase()];
  if (!mime) throw new Error(`${target.toUpperCase()} is not a canvas-encodable format.`);
  const img = await loadImage(file, file.name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : undefined);
  const natural = { width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 };
  const canvas = drawToCanvas(img, natural, options);
  if (options.compression) reduceColorDepth(canvas, colorBitsFor(target, options.compression));
  return canvasToBlob(canvas, mime, (options.quality ?? 92) / 100);
}

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/** Packs a multi-resolution .ico from a single source image (PNG payloads). */
export async function convertToIco(file: File, options: EditOptions = {}): Promise<Blob> {
  const img = await loadImage(file, file.name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : undefined);
  const natural = { width: img.naturalWidth || 256, height: img.naturalHeight || 256 };

  const entries = await Promise.all(
    ICO_SIZES.map(async (size) => {
      const canvas = drawToCanvas(img, natural, { ...options, resolution: `${size}x${size}`, scalePercent: undefined });
      const blob = await canvasToBlob(canvas, "image/png");
      return { size, data: new Uint8Array(await blob.arrayBuffer()) };
    })
  );

  const headerSize = 6 + entries.length * 16;
  const total = headerSize + entries.reduce((sum, e) => sum + e.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, entries.length, true);

  let offset = headerSize;
  entries.forEach((entry, i) => {
    const dir = 6 + i * 16;
    out[dir] = entry.size === 256 ? 0 : entry.size; // 0 means 256
    out[dir + 1] = entry.size === 256 ? 0 : entry.size;
    out[dir + 2] = 0; // palette
    out[dir + 3] = 0; // reserved
    view.setUint16(dir + 4, 1, true); // colour planes
    view.setUint16(dir + 6, 32, true); // bits per pixel
    view.setUint32(dir + 8, entry.data.length, true);
    view.setUint32(dir + 12, offset, true);
    out.set(entry.data, offset);
    offset += entry.data.length;
  });

  return new Blob([out], { type: "image/x-icon" });
}

/** Grabs a single frame from a video using the browser's own decoder. */
export async function grabVideoFrame(file: File, target: string, options: EditOptions = {}): Promise<Blob> {
  const mime = CANVAS_MIME[target.toLowerCase()];
  if (!mime) throw new Error(`${target.toUpperCase()} is not a canvas-encodable format.`);

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("The browser could not decode this video."));
      video.src = url;
    });

    const time = options.frameTimestamp ?? options.trimStart ?? 0;
    if (time > 0) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("Seeking failed."));
        video.currentTime = Math.min(time, Math.max(0, (video.duration || time) - 0.01));
      });
    }

    const canvas = drawToCanvas(video, { width: video.videoWidth, height: video.videoHeight }, options);
    return await canvasToBlob(canvas, mime, (options.quality ?? 92) / 100);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Decodes any browser-supported audio and re-encodes it as PCM WAV. */
export async function audioToWav(file: File, options: EditOptions = {}): Promise<Blob> {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const start = Math.max(0, options.trimStart ?? 0);
    const end = Math.min(decoded.duration, options.trimEnd ?? decoded.duration);
    const from = Math.floor(start * decoded.sampleRate);
    const to = Math.max(from + 1, Math.floor(end * decoded.sampleRate));
    const frames = to - from;
    const channels = decoded.numberOfChannels;

    const bytes = 44 + frames * channels * 2;
    const buffer = new ArrayBuffer(bytes);
    const view = new DataView(buffer);
    const writeString = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeString(0, "RIFF");
    view.setUint32(4, bytes - 8, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, decoded.sampleRate, true);
    view.setUint32(28, decoded.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, frames * channels * 2, true);

    const data = Array.from({ length: channels }, (_, c) => decoded.getChannelData(c));
    let offset = 44;
    for (let i = from; i < to; i++) {
      for (let c = 0; c < channels; c++) {
        const sample = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    ctx.close();
  }
}
