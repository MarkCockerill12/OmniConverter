import type { EditOptions } from "@/lib/formats";

/**
 * WebCodecs fast lane.
 *
 * Mediabunny demuxes, re-encodes through the platform's hardware codecs and
 * remuxes — typically 5-20x faster than FFmpeg.wasm for H.264/AAC work, with
 * no 30 MB core download. Anything it cannot express (colour keying, GIF,
 * exotic containers) falls back to the FFmpeg worker.
 */

/** Containers mediabunny can write, mapped to their output-format class name. */
const OUTPUT_FORMATS = ["mp4", "mov", "mkv", "webm", "mp3", "wav", "ogg", "flac", "m4a"] as const;
/** Containers mediabunny can read. */
const INPUT_FORMATS = ["mp4", "mov", "m4a", "mkv", "webm", "mp3", "wav", "ogg", "flac", "aac", "ts"];

export function fastLaneSupports(sourceExt: string, targetExt: string, options: EditOptions = {}) {
  if (typeof window === "undefined") return false;
  if (typeof (window as any).VideoEncoder === "undefined" && typeof (window as any).AudioEncoder === "undefined") return false;
  if (!INPUT_FORMATS.includes(sourceExt)) return false;
  if (!(OUTPUT_FORMATS as readonly string[]).includes(targetExt)) return false;
  // Colour keying has no WebCodecs equivalent; leave it to FFmpeg's filter graph.
  if (options.transparencyColor) return false;
  // Playback-rate changes need a filter graph too.
  if (options.speed && options.speed !== 1) return false;
  return true;
}

async function buildOutputFormat(target: string) {
  const mb = await import("mediabunny");
  switch (target) {
    case "mp4":
    case "m4a":
      return new mb.Mp4OutputFormat();
    case "mov":
      return new mb.MovOutputFormat();
    case "mkv":
      return new mb.MkvOutputFormat();
    case "webm":
      return new mb.WebMOutputFormat();
    case "mp3":
      return new mb.Mp3OutputFormat();
    case "wav":
      return new mb.WavOutputFormat();
    case "ogg":
      return new mb.OggOutputFormat();
    case "flac":
      return new mb.FlacOutputFormat();
    default:
      throw new Error(`No fast-lane container for .${target}`);
  }
}

const AUDIO_ONLY = new Set(["mp3", "wav", "ogg", "flac", "m4a"]);

const OUTPUT_MIME: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
};

/**
 * Draws subtitle cues straight onto decoded frames. FFmpeg.wasm's core carries
 * no libass, so burn-in happens here on a canvas instead.
 */
function buildSubtitleRenderer(cues: NonNullable<EditOptions["subtitles"]>) {
  let canvas: OffscreenCanvas | null = null;

  return (sample: { timestamp: number; displayWidth: number; displayHeight: number; toCanvasImageSource: () => CanvasImageSource }) => {
    const width = sample.displayWidth;
    const height = sample.displayHeight;
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return sample.toCanvasImageSource();

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(sample.toCanvasImageSource(), 0, 0, width, height);

    const cue = cues.find((c) => sample.timestamp >= c.start && sample.timestamp <= c.end);
    if (cue) {
      const fontSize = Math.max(14, Math.round(height * 0.055));
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, fontSize * 0.18);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "#ffffff";

      // Wrap to ~90% of the frame width.
      const maxWidth = width * 0.9;
      const lines: string[] = [];
      for (const raw of cue.text.split("\n")) {
        let line = "";
        for (const word of raw.split(" ")) {
          const candidate = line ? `${line} ${word}` : word;
          if (ctx.measureText(candidate).width > maxWidth && line) {
            lines.push(line);
            line = word;
          } else {
            line = candidate;
          }
        }
        if (line) lines.push(line);
      }

      let y = height - Math.round(height * 0.06);
      for (const line of lines.reverse()) {
        ctx.strokeText(line, width / 2, y);
        ctx.fillText(line, width / 2, y);
        y -= fontSize * 1.2;
      }
    }
    return canvas;
  };
}

/**
 * Runs a conversion entirely on the platform's media stack.
 * Throws (so the caller can fall back to FFmpeg) when the requested output is
 * not encodable on this device.
 */
export async function convertMediaFast(
  file: File,
  target: string,
  options: EditOptions = {},
  onProgress?: (percent: number) => void
): Promise<Blob> {
  const mb = await import("mediabunny");
  const lower = target.toLowerCase();

  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: await buildOutputFormat(lower), target: new mb.BufferTarget() });

  const audioOnly = AUDIO_ONLY.has(lower);
  const video: Record<string, unknown> = audioOnly ? { discard: true } : {};

  if (!audioOnly) {
    if (options.crop) {
      video.crop = { left: options.crop.x, top: options.crop.y, width: options.crop.width, height: options.crop.height };
    }
    if (options.resolution) {
      const [w, h] = options.resolution.split("x").map(Number);
      if (w > 0 && h > 0) {
        video.width = w;
        video.height = h;
        video.fit = "contain";
      } else if (w > 0) {
        video.width = w; // height follows the aspect ratio
      } else if (h > 0) {
        video.height = h;
      }
    }
    if (options.fps) video.frameRate = options.fps;
    if (options.videoBitrate) video.quality = new mb.Quality({ bitrate: options.videoBitrate });
    if (options.subtitles?.length) video.process = buildSubtitleRenderer(options.subtitles);
  }

  const audio: Record<string, unknown> = {};
  if (options.audioBitrate) {
    const bits = parseInt(options.audioBitrate, 10) * 1000;
    if (Number.isFinite(bits) && bits > 0) audio.quality = new mb.Quality({ bitrate: bits });
  }

  const trim: { start?: number; end?: number } = {};
  if (options.trimStart) trim.start = options.trimStart;
  if (options.trimEnd) trim.end = options.trimEnd;

  const conversion = await mb.Conversion.init({
    input,
    output,
    video: video as never,
    audio: audio as never,
    ...(trim.start !== undefined || trim.end !== undefined ? { trim } : {}),
    showWarnings: false,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => t.reason).join(", ");
    throw new Error(`Fast lane cannot produce this output (${reasons || "unsupported codec"}).`);
  }

  if (onProgress) conversion.onProgress = (progress) => onProgress(Math.round(progress * 100));
  await conversion.execute();

  const buffer = (output.target as { buffer: ArrayBuffer | null }).buffer;
  if (!buffer) throw new Error("Fast lane produced no output.");
  return new Blob([buffer], { type: OUTPUT_MIME[lower] || "application/octet-stream" });
}

/** Scales a percentage request into explicit pixel dimensions for the fast lane. */
export async function resolveScaledResolution(file: File, scalePercent: number): Promise<string | undefined> {
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return undefined;
    const width = Math.max(2, Math.round((track.displayWidth * scalePercent) / 100));
    const height = Math.max(2, Math.round((track.displayHeight * scalePercent) / 100));
    // Encoders require even dimensions for 4:2:0 chroma.
    return `${width - (width % 2)}x${height - (height % 2)}`;
  } catch {
    return undefined;
  }
}
