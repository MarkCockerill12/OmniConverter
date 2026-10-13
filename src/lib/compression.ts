import type { Category, CompressionLevel, EditOptions } from "./formats";

/**
 * One compression dial for every file type.
 *
 * The level is a statement of intent; this module turns it into the concrete
 * knob each engine understands (JPEG quality, CRF, bitrate, colour depth,
 * embedded-image resampling). Anything the user set by hand always wins.
 */

export const COMPRESSION_LEVELS: { id: CompressionLevel; label: string }[] = [
  { id: "lossless", label: "Lossless" },
  { id: "balanced", label: "Balanced" },
  { id: "small", label: "Small" },
  { id: "smallest", label: "Smallest" },
];

const STEP: Record<CompressionLevel, number> = { lossless: 0, balanced: 1, small: 2, smallest: 3 };
const pick = <T,>(level: CompressionLevel, values: [T, T, T, T]) => values[STEP[level]];

const PCM_TARGETS = new Set(["wav", "flac"]);
const LOSSLESS_VIDEO_TARGETS = new Set(["mp4", "mkv", "mov", "webm"]);

/** Encoder quality (1-100) for lossy still-image formats. */
export function imageQualityFor(target: string, level: CompressionLevel): number | undefined {
  switch (target.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return pick(level, [100, 82, 68, 50]);
    case "webp":
      // Chromium's WebP encoder switches to true lossless at quality 100.
      return pick(level, [100, 80, 65, 45]);
    case "tiff":
      return pick(level, [100, 85, 70, 55]);
    default:
      return undefined;
  }
}

/**
 * Bits kept per colour channel for formats with no lossy mode of their own
 * (PNG). Fewer distinct colours deflate far better; 8 means untouched.
 */
export function colorBitsFor(target: string, level: CompressionLevel): number {
  return target.toLowerCase() === "png" ? pick(level, [8, 6, 5, 4]) : 8;
}

/** x264/VP9 constant rate factor. 0 is mathematically lossless. */
export function videoCrfFor(level: CompressionLevel): number {
  return pick(level, [0, 26, 30, 35]);
}

export function audioBitrateFor(level: CompressionLevel): string {
  return pick(level, ["320k", "160k", "96k", "64k"]);
}

/** Uncompressed and lossless audio can only shrink by carrying less signal. */
export function pcmShapeFor(target: string, level: CompressionLevel): { sampleRate?: number; mono?: boolean } {
  if (!PCM_TARGETS.has(target.toLowerCase())) return {};
  return pick<{ sampleRate?: number; mono?: boolean }>(level, [
    {},
    { sampleRate: 44100 },
    { sampleRate: 32000 },
    { sampleRate: 22050, mono: true },
  ]);
}

/** Resampling applied to the pictures embedded in a PDF. */
export function pdfImagePlanFor(level: CompressionLevel): { quality: number; maxEdge: number } | null {
  return pick<{ quality: number; maxEdge: number } | null>(level, [
    null,
    { quality: 0.78, maxEdge: 2200 },
    { quality: 0.62, maxEdge: 1600 },
    { quality: 0.42, maxEdge: 1100 },
  ]);
}

/** GLB post-processing for each level. */
export function modelPlanFor(level: CompressionLevel): { dedup: boolean; compress: boolean; maxTextureSize?: number } {
  return pick<{ dedup: boolean; compress: boolean; maxTextureSize?: number }>(level, [
    { dedup: true, compress: false },
    { dedup: true, compress: true },
    { dedup: true, compress: true, maxTextureSize: 2048 },
    { dedup: true, compress: true, maxTextureSize: 1024 },
  ]);
}

/** True when a lossless request can be honoured only by FFmpeg's software encoders. */
export function needsLosslessVideo(target: string, options: EditOptions) {
  return options.compression === "lossless" && LOSSLESS_VIDEO_TARGETS.has(target.toLowerCase());
}

/**
 * Fills in the encoder settings a compression level implies, leaving any value
 * the user picked explicitly alone.
 */
export function resolveCompression(options: EditOptions, target: string): EditOptions {
  const level = options.compression;
  if (!level) return options;
  const lower = target.toLowerCase();
  const next: EditOptions = { ...options };

  if (next.quality === undefined) next.quality = imageQualityFor(lower, level);
  if (next.audioBitrate === undefined && !PCM_TARGETS.has(lower)) next.audioBitrate = audioBitrateFor(level);
  const pcm = pcmShapeFor(lower, level);
  if (pcm.mono) next.mono = true;
  return next;
}

/** One line telling the user what a level will actually do to this output. */
export function describeCompression(category: Category, target: string, level: CompressionLevel | undefined): string {
  if (!level) return "Off: the encoder's defaults are used.";
  const lower = target.toLowerCase();
  const lossless = level === "lossless";

  if (category === "Archive") return "Archives are always lossless; use the pack level below.";
  if (category === "3D Model") {
    if (lower !== "glb") return "Only GLB output can be compressed.";
    const plan = modelPlanFor(level);
    if (lossless) return "Merges duplicate meshes, materials and textures. Geometry is untouched.";
    return `Meshopt geometry compression${plan.maxTextureSize ? `, textures capped at ${plan.maxTextureSize}px` : ""}. Needs a Meshopt-aware loader.`;
  }
  if (lower === "pdf") {
    const plan = pdfImagePlanFor(level);
    if (!plan) return "Repacks the file structure. Text, vectors and pictures are untouched.";
    return `Also re-encodes embedded pictures at ${Math.round(plan.quality * 100)}% quality, at most ${plan.maxEdge}px. Text stays sharp.`;
  }
  if (lower === "png") {
    const bits = colorBitsFor(lower, level);
    return lossless ? "PNG is lossless: every pixel is kept." : `Reduces colour depth to ${bits} bits per channel so the file deflates better.`;
  }
  if (lower === "jpg" || lower === "jpeg") {
    return lossless ? "JPEG has no lossless mode; this uses its maximum quality." : `JPEG quality ${imageQualityFor(lower, level)}.`;
  }
  if (lower === "webp") return lossless ? "Lossless WebP: every pixel is kept." : `WebP quality ${imageQualityFor(lower, level)}.`;
  if (lower === "gif" || lower === "bmp" || lower === "ico") return "This format has no adjustable compression.";
  if (PCM_TARGETS.has(lower)) {
    const shape = pcmShapeFor(lower, level);
    if (!shape.sampleRate) return lower === "flac" ? "FLAC: bit-exact audio at roughly half the size of WAV." : "WAV is uncompressed; pick FLAC for lossless savings.";
    return `Resamples to ${(shape.sampleRate / 1000).toFixed(shape.sampleRate % 1000 ? 2 : 0)} kHz${shape.mono ? " mono" : ""}.`;
  }
  if (category === "Audio" || ["mp3", "ogg", "m4a"].includes(lower)) {
    return lossless ? `${target.toUpperCase()} is a lossy codec; this uses its highest bitrate (320 kbps).` : `${audioBitrateFor(level).replace("k", " kbps")} audio.`;
  }
  if (category === "Video") {
    if (lossless) {
      return LOSSLESS_VIDEO_TARGETS.has(lower)
        ? "Mathematically lossless video. Slow to encode and usually larger than the source."
        : "This container has no lossless mode here.";
    }
    return `Lower video bitrate (quality factor ${videoCrfFor(level)}), ${audioBitrateFor(level).replace("k", " kbps")} audio.`;
  }
  return "Applied where the output format allows it.";
}
