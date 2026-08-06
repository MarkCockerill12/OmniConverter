import { getExtension } from "./utils";

export type Category = "Image" | "3D Model" | "Document" | "Video" | "Audio" | "Archive" | "Unrecognized";

export const FORMAT_CATEGORIES: Record<Category, string[]> = {
  "Image": ["PNG", "JPG", "JPEG", "WEBP", "GIF", "TIFF", "BMP", "SVG", "ICO", "AVIF"],
  "3D Model": ["GLB", "GLTF", "OBJ", "STL", "FBX", "DAE", "3MF", "PLY", "SZS", "MDL0"],
  "Document": ["PDF", "DOCX", "DOC", "TXT", "RTF", "MD"],
  "Video": ["MP4", "WEBM", "MKV", "MOV", "AVI", "TS", "M4V"],
  "Audio": ["MP3", "WAV", "FLAC", "OGG", "M4A", "AAC", "OPUS"],
  "Archive": ["ZIP", "RAR", "7Z", "TAR", "GZ", "TGZ"],
  "Unrecognized": []
};

export const IMAGE_TARGETS = ["PNG", "JPG", "JPEG", "WEBP", "GIF", "TIFF", "BMP", "ICO"];
export const RASTER_TARGETS = ["PNG", "JPG", "JPEG", "WEBP"];
export const VIDEO_TARGETS = ["MP4", "WEBM", "MKV", "MOV", "AVI"];
export const AUDIO_TARGETS = ["MP3", "WAV", "FLAC", "OGG", "M4A"];
export const MODEL_TARGETS = ["GLB", "GLTF", "OBJ", "STL"];
export const ARCHIVE_TARGETS = ["ZIP", "TAR", "GZ"];

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface EditOptions {
  trimStart?: number;
  trimEnd?: number;
  crop?: { x: number; y: number; width: number; height: number };
  resolution?: string;
  /** Uniform scale as a percentage of the source size. */
  scalePercent?: number;
  /** Encoder quality for lossy image output, 1-100. */
  quality?: number;
  /** Keep source metadata (EXIF/tags); forces the FFmpeg path for images. */
  preserveMetadata?: boolean;
  transparencyColor?: string;
  transparencySimilarity?: number;
  transparencyBlend?: number;
  audioBitrate?: string;
  /** Explicit video bitrate in bits per second. */
  videoBitrate?: number;
  /** Desired output size; converted to a bitrate once the duration is known. */
  targetSizeMB?: number;
  fps?: number;
  /** Playback rate multiplier (0.25 - 4). */
  speed?: number;
  frameTimestamp?: number;
  subtitles?: SubtitleCue[];
  subtitleName?: string;
}

export function getFileCategory(fileName: string): Category {
  const ext = fileName.split('.').pop()?.toUpperCase() || "";
  for (const [cat, exts] of Object.entries(FORMAT_CATEGORIES)) {
    if (exts.includes(ext)) return cat as Category;
  }
  return "Unrecognized";
}

/**
 * The formats Omni can actually produce for a given source file, grouped by
 * category. An empty result means no engine handles that input.
 */
export function allowedTargets(fileName: string): Partial<Record<Category, string[]>> {
  const ext = getExtension(fileName);
  switch (getFileCategory(fileName)) {
    case "Image":
      // Vector sources are rasterised on a canvas, which only writes RGB formats.
      return ext === "svg"
        ? { "Image": [...RASTER_TARGETS, "ICO"], "Document": ["PDF"] }
        : { "Image": IMAGE_TARGETS, "Document": ["PDF"] };
    case "Video":
      return { "Video": VIDEO_TARGETS, "Audio": AUDIO_TARGETS, "Image": [...RASTER_TARGETS, "GIF"] };
    case "Audio":
      return { "Audio": AUDIO_TARGETS };
    case "3D Model":
      return { "3D Model": MODEL_TARGETS };
    case "Archive":
      if (ext === "rar" || ext === "7z") return {}; // no client-side reader for these containers
      // ZIPs are usually model bundles here, so the 3D tab leads; plain
      // tarballs are more likely to just need repacking.
      return ext === "zip"
        ? { "3D Model": MODEL_TARGETS, "Archive": ARCHIVE_TARGETS }
        : { "Archive": ARCHIVE_TARGETS, "3D Model": MODEL_TARGETS };
    case "Document":
      return ext === "pdf" ? { "Image": RASTER_TARGETS, "Document": ["TXT"] } : {};
    default:
      return {};
  }
}

/** True when Omni has an engine that can convert this file to something. */
export function canConvert(fileName: string) {
  return Object.keys(allowedTargets(fileName)).length > 0;
}

export interface Preset {
  id: string;
  label: string;
  hint: string;
  target: string;
  categories: Category[];
  options: EditOptions;
}

/**
 * One-click recipes. `targetSizeMB` is resolved into a bitrate at conversion
 * time, once the source duration is known.
 */
export const PRESETS: Preset[] = [
  {
    id: "discord",
    label: "Discord 10 MB",
    hint: "720p, size-capped MP4",
    target: "MP4",
    categories: ["Video"],
    options: { resolution: "1280x720", targetSizeMB: 10, audioBitrate: "128k" },
  },
  {
    id: "whatsapp",
    label: "WhatsApp 16 MB",
    hint: "480p, size-capped MP4",
    target: "MP4",
    categories: ["Video"],
    options: { resolution: "854x480", targetSizeMB: 16, audioBitrate: "128k" },
  },
  {
    id: "instagram",
    label: "Instagram 1:1",
    hint: "1080x1080 square MP4",
    target: "MP4",
    categories: ["Video"],
    options: { resolution: "1080x1080", videoBitrate: 5_000_000, audioBitrate: "192k" },
  },
  {
    id: "web720",
    label: "Web 720p",
    hint: "Balanced streaming MP4",
    target: "MP4",
    categories: ["Video"],
    options: { resolution: "1280x720", videoBitrate: 2_500_000, audioBitrate: "160k" },
  },
  {
    id: "gif",
    label: "Share GIF",
    hint: "480px, 15 fps, dithered palette",
    target: "GIF",
    categories: ["Video"],
    options: { resolution: "480x-2", fps: 15 },
  },
  {
    id: "podcast",
    label: "Podcast MP3",
    hint: "Mono-friendly 128 kbps",
    target: "MP3",
    categories: ["Video", "Audio"],
    options: { audioBitrate: "128k" },
  },
  {
    id: "web-image",
    label: "Web image",
    hint: "WEBP at 80% quality",
    target: "WEBP",
    categories: ["Image"],
    options: { quality: 80 },
  },
  {
    id: "thumbnail",
    label: "Thumbnail",
    hint: "50% scale JPG",
    target: "JPG",
    categories: ["Image"],
    options: { scalePercent: 50, quality: 85 },
  },
];

/** Parses SRT or WebVTT into cue objects for burn-in. */
export function parseSubtitles(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const toSeconds = (stamp: string) => {
    const [h, m, s] = stamp.replace(",", ".").split(":");
    return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
  };

  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() && !/^WEBVTT/i.test(l));
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const [from, to] = lines[timingIndex].split("-->").map((s) => s.trim().split(" ")[0]);
    const body = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!body) continue;
    try {
      cues.push({ start: toSeconds(from), end: toSeconds(to), text: body });
    } catch {
      /* skip malformed cue */
    }
  }
  return cues;
}
