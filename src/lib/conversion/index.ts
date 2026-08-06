import { getExtension, stripExtension } from "@/lib/utils";
import { getFileCategory, MODEL_TARGETS, type EditOptions } from "@/lib/formats";
import { CANVAS_MIME } from "./native";
import { fastLaneSupports } from "./fast-media";

/**
 * Conversion router.
 *
 * Every job is dispatched to the cheapest engine that can produce the result:
 * canvas/WebAudio first, then the WebCodecs fast lane, then the headless
 * Three.js pipeline, and finally FFmpeg.wasm as the universal fallback.
 */

export type Engine = "native" | "webcodecs" | "ffmpeg" | "three" | "document" | "archive";

export interface FfmpegBridge {
  (payload: { file: File; target: string; options: EditOptions; onProgress: (percent: number) => void }): Promise<Blob>;
}

export interface ConvertRequest {
  file: File;
  target: string;
  options?: EditOptions;
  ffmpeg: FfmpegBridge;
  nintendoWorker?: Worker | null;
  onProgress?: (percent: number) => void;
  onEngine?: (engine: Engine) => void;
}

export interface ConvertResult {
  blob: Blob;
  fileName: string;
  engine: Engine;
}

/** Reads a media file's duration without decoding it. */
export async function readDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  const el = document.createElement(file.type.startsWith("audio") ? "audio" : "video");
  try {
    return await new Promise<number>((resolve) => {
      const done = (value: number) => resolve(Number.isFinite(value) && value > 0 ? value : 0);
      el.onloadedmetadata = () => done(el.duration);
      el.onerror = () => done(0);
      el.preload = "metadata";
      el.src = url;
      setTimeout(() => done(0), 10_000);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Turns a target file size into a video bitrate, leaving room for the audio track. */
async function resolveTargetSize(file: File, options: EditOptions): Promise<EditOptions> {
  if (!options.targetSizeMB) return options;
  const duration = (options.trimEnd ?? 0) - (options.trimStart ?? 0) || (await readDuration(file));
  if (!duration) return options;

  const audioBits = parseInt(options.audioBitrate || "128k", 10) * 1000 || 128_000;
  const totalBits = options.targetSizeMB * 1024 * 1024 * 8 * 0.96; // 4% container overhead
  const videoBitrate = Math.floor(totalBits / duration - audioBits);
  if (videoBitrate < 100_000) return { ...options, videoBitrate: 100_000 };
  return { ...options, videoBitrate };
}

function outputName(sourceName: string, extension: string) {
  const base = stripExtension(sourceName);
  const sourceExt = getExtension(sourceName);
  // Avoid handing back a file that looks identical to the input.
  return sourceExt === extension ? `${base}_converted.${extension}` : `${base}.${extension}`;
}

export async function convertFile(request: ConvertRequest): Promise<ConvertResult> {
  const { file, ffmpeg, nintendoWorker, onProgress, onEngine } = request;
  const target = request.target.toLowerCase();
  const ext = getExtension(file.name);
  const category = getFileCategory(file.name);
  const options = await resolveTargetSize(file, request.options || {});
  const report = (engine: Engine) => onEngine?.(engine);
  const finish = (blob: Blob, engine: Engine, extension = target): ConvertResult => {
    onProgress?.(100);
    return { blob, fileName: outputName(file.name, extension), engine };
  };

  // 1. 3D models, and archives asked to produce a model.
  if (category === "3D Model" || (category === "Archive" && MODEL_TARGETS.includes(target.toUpperCase()))) {
    report("three");
    onProgress?.(20);
    const { convert3DModelHeadless } = await import("@/lib/3d-converter");
    return finish(await convert3DModelHeadless(file, target, nintendoWorker), "three");
  }

  // 2. Archive repacking.
  if (category === "Archive") {
    report("archive");
    onProgress?.(30);
    const { convertArchive } = await import("./archives");
    const { blob, extension } = await convertArchive(file, target);
    return finish(blob, "archive", extension);
  }

  // 3. PDF in, images or text out.
  if (ext === "pdf") {
    report("document");
    onProgress?.(20);
    const documents = await import("./documents");
    if (target === "txt") return finish(await documents.pdfToText(file), "document");
    const blob = await documents.pdfToImages(file, target, options);
    return finish(blob, "document", blob.type === "application/zip" ? "zip" : target);
  }

  // 4. Images.
  if (category === "Image") {
    if (target === "pdf") {
      report("document");
      const { imageToPdf } = await import("./documents");
      return finish(await imageToPdf(file, options), "document");
    }
    const native = await import("./native");
    if (target === "ico") {
      report("native");
      return finish(await native.convertToIco(file, options), "native");
    }
    // Canvas cannot key out colours, write GIF/TIFF/BMP, or preserve EXIF.
    const canUseCanvas = !!CANVAS_MIME[target] && !options.transparencyColor && !options.preserveMetadata;
    if (canUseCanvas) {
      report("native");
      return finish(await native.convertImageNative(file, target, options), "native");
    }
    report("ffmpeg");
    return finish(await ffmpeg({ file, target, options, onProgress: (p) => onProgress?.(p) }), "ffmpeg");
  }

  // 5. Single frame out of a video: the browser's own decoder is instant.
  if (category === "Video" && CANVAS_MIME[target]) {
    const native = await import("./native");
    try {
      report("native");
      return finish(await native.grabVideoFrame(file, target, options), "native");
    } catch {
      report("ffmpeg");
      return finish(await ffmpeg({ file, target, options, onProgress: (p) => onProgress?.(p) }), "ffmpeg");
    }
  }

  // 6. Audio and video: WebCodecs where possible, FFmpeg otherwise.
  if (category === "Video" || category === "Audio") {
    if (fastLaneSupports(ext, target, options)) {
      try {
        report("webcodecs");
        const fast = await import("./fast-media");
        let fastOptions = options;
        if (options.scalePercent && !options.resolution) {
          const resolution = await fast.resolveScaledResolution(file, options.scalePercent);
          if (resolution) fastOptions = { ...options, resolution };
        }
        const blob = await fast.convertMediaFast(file, target, fastOptions, (p) => onProgress?.(p));
        return finish(blob, "webcodecs");
      } catch (err) {
        console.warn("[Convert] Fast lane unavailable, falling back to FFmpeg:", err);
      }
    }

    if (target === "wav" && category === "Audio" && !options.transparencyColor && !options.speed) {
      try {
        report("native");
        const { audioToWav } = await import("./native");
        return finish(await audioToWav(file, options), "native");
      } catch {
        /* fall through to FFmpeg */
      }
    }
  }

  // 7. Everything else.
  report("ffmpeg");
  return finish(await ffmpeg({ file, target, options, onProgress: (p) => onProgress?.(p) }), "ffmpeg");
}
