/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

/**
 * Media Worker
 * Owns the FFmpeg.wasm instance. The core is streamed from a CDN (with
 * fallbacks) so the app bundle stays small; everything then runs locally.
 *
 * This is the fallback engine: the main thread prefers canvas and WebCodecs and
 * only reaches here for filter-graph work (colour keying, GIF palettes, speed
 * changes) or codecs the platform cannot handle.
 */

const CORE_CDNS = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
  'https://cdnjs.cloudflare.com/ajax/libs/ffmpeg-core/0.12.6',
];

const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', gif: 'image/gif', webp: 'image/webp',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', tiff: 'image/tiff',
};

const isLowRam = (((navigator as any).deviceMemory as number) || 8) < 4;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let activeFileId: string | null = null;
let logTail: string[] = [];
/** Jobs are serialised: one FFmpeg instance cannot run two graphs at once. */
let queue: Promise<unknown> = Promise.resolve();

/** Picks the most useful line out of the FFmpeg log tail. */
function describeFailure(fallback: string) {
  const meaningful = [...logTail].reverse().find((line) =>
    /error|invalid|does not contain any stream|unable to find|no such file|unsupported|failed/i.test(line)
  );
  return meaningful ? meaningful.replace(/^\[[^\]]+\]\s*/, '').trim().slice(0, 180) : fallback;
}

async function ensureLoaded(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (!loadPromise) {
    loadPromise = (async () => {
      const instance = new FFmpeg();
      // Progress and logs are per-instance; register the listeners exactly once.
      instance.on('progress', ({ progress }: { progress: number }) => {
        if (activeFileId !== null) {
          self.postMessage({ type: 'CONVERSION_PROGRESS', fileId: activeFileId, progress: Math.round(progress * 100) });
        }
      });
      instance.on('log', ({ message }: { message: string }) => {
        logTail.push(message);
        if (logTail.length > 40) logTail.shift();
      });

      let lastError: unknown;
      for (const baseURL of CORE_CDNS) {
        try {
          self.postMessage({ type: 'LOG', message: `FFmpeg: loading core from ${baseURL}...` });
          await instance.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          });
          ffmpeg = instance;
          return instance;
        } catch (e) {
          lastError = e;
          console.warn(`Failed to load FFmpeg core from ${baseURL}, trying next...`);
        }
      }
      loadPromise = null;
      throw new Error(`All FFmpeg CDNs failed to load. ${lastError ?? ''}`);
    })();
  }
  return loadPromise;
}

interface TranscodeOptions {
  trimStart?: number;
  trimEnd?: number;
  crop?: { x: number; y: number; width: number; height: number };
  resolution?: string;
  scalePercent?: number;
  quality?: number;
  preserveMetadata?: boolean;
  transparencyColor?: string;
  transparencySimilarity?: number;
  transparencyBlend?: number;
  audioBitrate?: string;
  videoBitrate?: number;
  fps?: number;
  speed?: number;
  frameTimestamp?: number;
}

const STILL_IMAGE = /^(png|jpg|jpeg|webp|bmp|tiff)$/;
const AUDIO_ONLY = /^(mp3|wav|flac|ogg|m4a)$/;

/** Video filter chain shared by the single-pass and GIF palette runs. */
function videoFilters(options: TranscodeOptions, target: string) {
  const filters: string[] = [];
  if (options.transparencyColor) {
    const color = options.transparencyColor.startsWith('#') ? options.transparencyColor : `#${options.transparencyColor}`;
    filters.push(`colorkey=${color}:${options.transparencySimilarity ?? 0.1}:${options.transparencyBlend ?? 0.1}`);
  }
  if (options.crop) {
    const { width: w, height: h, x, y } = options.crop;
    filters.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (options.speed && options.speed !== 1) filters.push(`setpts=${(1 / options.speed).toFixed(4)}*PTS`);
  if (options.fps && target !== 'gif') filters.push(`fps=${options.fps}`);
  if (options.resolution) {
    filters.push(`scale=${options.resolution.replace('x', ':')}:flags=lanczos`);
  } else if (options.scalePercent && options.scalePercent !== 100) {
    const factor = (options.scalePercent / 100).toFixed(4);
    filters.push(`scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2:flags=lanczos`);
  }
  return filters;
}

/** atempo only accepts 0.5-2.0, so larger changes are chained. */
function audioFilters(options: TranscodeOptions) {
  const filters: string[] = [];
  let speed = options.speed && options.speed !== 1 ? options.speed : 0;
  while (speed) {
    const step = Math.max(0.5, Math.min(2, speed));
    filters.push(`atempo=${step.toFixed(4)}`);
    speed = Math.abs(speed / step - 1) < 0.001 ? 0 : speed / step;
  }
  return filters;
}

/** Builds the FFmpeg argument list for one conversion. */
function buildArgs(inputName: string, outputName: string, targetFormat: string, options: TranscodeOptions = {}) {
  const args: string[] = [];
  const target = targetFormat.toLowerCase();

  // Seeking before -i is orders of magnitude faster than seeking on output.
  const start = options.frameTimestamp ?? options.trimStart;
  if (start !== undefined && start > 0) args.push('-ss', String(start));

  args.push('-i', inputName);

  // Output timestamps restart at 0 after an input seek, so trim with a
  // duration rather than an absolute end time.
  if (options.frameTimestamp === undefined && options.trimEnd !== undefined) {
    const duration = options.trimEnd - (options.trimStart ?? 0);
    if (duration > 0) args.push('-t', String(duration));
  }

  const vf = videoFilters(options, target);
  if (vf.length > 0) args.push('-vf', vf.join(','));
  const af = audioFilters(options);
  if (af.length > 0 && !STILL_IMAGE.test(target)) args.push('-af', af.join(','));

  if (options.audioBitrate) args.push('-b:a', options.audioBitrate);
  if (options.videoBitrate && !STILL_IMAGE.test(target)) {
    args.push('-b:v', String(options.videoBitrate), '-maxrate', String(options.videoBitrate), '-bufsize', String(options.videoBitrate * 2));
  }
  // JPEG/TIFF quality: FFmpeg's scale is inverted (1 best, 31 worst).
  if (options.quality && /^(jpg|jpeg|tiff)$/.test(target)) {
    args.push('-q:v', String(Math.max(1, Math.round(31 - (options.quality / 100) * 30))));
  }
  if (options.quality && target === 'webp') args.push('-quality', String(options.quality));
  if (!options.preserveMetadata) args.push('-map_metadata', '-1');

  // Single-frame stills (either an explicit frame grab or a still-image target).
  if (options.frameTimestamp !== undefined || STILL_IMAGE.test(target)) args.push('-frames:v', '1');
  // Dropping the video stream keeps audio containers valid (e.g. cover art in MP3).
  if (AUDIO_ONLY.test(target)) args.push('-vn');

  args.push(outputName);
  return args;
}

/**
 * GIF encoding in two passes: an optimised 256-colour palette is generated
 * first, then applied with dithering. Single-pass GIF output is visibly worse.
 */
async function encodeGif(instance: FFmpeg, inputName: string, outputName: string, options: TranscodeOptions) {
  const fps = options.fps ?? 15;
  const chain = [...videoFilters(options, 'gif'), `fps=${fps}`].join(',');
  const paletteName = `${outputName}.palette.png`;

  const seek: string[] = [];
  if (options.trimStart) seek.push('-ss', String(options.trimStart));
  const duration: string[] = [];
  if (options.trimEnd !== undefined) {
    const length = options.trimEnd - (options.trimStart ?? 0);
    if (length > 0) duration.push('-t', String(length));
  }

  await instance.exec([...seek, '-i', inputName, ...duration, '-vf', `${chain},palettegen=stats_mode=diff`, '-y', paletteName]);
  await instance.exec([
    ...seek, '-i', inputName, '-i', paletteName, ...duration,
    '-lavfi', `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    '-loop', '0', '-y', outputName,
  ]);
  try { await instance.deleteFile(paletteName); } catch { /* already gone */ }
}

async function transcode(payload: { file: File; targetFormat: string; fileId: string; options?: TranscodeOptions }) {
  const { file, targetFormat, fileId, options } = payload;
  const target = targetFormat.toLowerCase();
  const inputName = `in_${fileId}.${file.name.split('.').pop() || 'bin'}`;
  const outputName = `out_${fileId}.${target}`;

  try {
    const instance = await ensureLoaded();
    activeFileId = fileId;
    logTail = [];

    await instance.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

    if (target === 'gif') {
      self.postMessage({ type: 'LOG', message: 'FFmpeg: GIF palette pass' });
      await encodeGif(instance, inputName, outputName, options || {});
    } else {
      const args = buildArgs(inputName, outputName, targetFormat, options);
      self.postMessage({ type: 'LOG', message: `FFmpeg: ffmpeg ${args.join(' ')}` });
      await instance.exec(args);
    }

    const data = await instance.readFile(outputName);
    const blob = new Blob([data as any], { type: MIME_TYPES[target] || 'application/octet-stream' });

    self.postMessage({
      type: 'CONVERSION_SUCCESS',
      fileId,
      output: blob,
      fileName: `${file.name.replace(/\.[^/.]+$/, '')}.${target}`,
    });
  } catch (error: any) {
    const raw = error?.message || String(error);
    const message = /FS error|ErrnoError/i.test(raw) ? describeFailure(raw) : raw;
    self.postMessage({ type: 'CONVERSION_ERROR', fileId, error: message });
  } finally {
    activeFileId = null;
    // Free the virtual FS so long queues cannot exhaust WASM memory.
    for (const name of [inputName, outputName]) {
      try { await ffmpeg?.deleteFile(name); } catch { /* never written */ }
    }
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    queue = queue.then(async () => {
      try {
        await ensureLoaded();
        self.postMessage({ type: 'INIT_SUCCESS', isLowRam });
      } catch (error: any) {
        self.postMessage({ type: 'INIT_ERROR', error: error.message || String(error) });
      }
    });
    return;
  }

  if (type === 'TRANSCODE') {
    // Queue rather than run: the main thread may dispatch several jobs at once.
    queue = queue.then(() => transcode(payload));
  }
};
