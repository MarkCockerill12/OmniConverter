/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { unzipSync } from 'fflate';

/**
 * Media Worker
 * Using standard imports which Next.js/Webpack will bundle.
 * Core is still loaded from CDN to keep the bundle size small.
 */

let ffmpeg: FFmpeg | null = null;
let isLoaded = false;
let isLoading = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    const deviceMemory = (navigator as any).deviceMemory || 8;
    const isLowRam = deviceMemory < 4;

    if (isLoaded) {
      self.postMessage({ type: 'INIT_SUCCESS', isLowRam });
      return;
    }
    if (isLoading) return;
    
    isLoading = true;
    try {
      ffmpeg = new FFmpeg();
      
      const CDNs = [
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
        'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
        'https://cdnjs.cloudflare.com/ajax/libs/ffmpeg-core/0.12.6'
      ];

      let loaded = false;
      for (const baseURL of CDNs) {
        try {
          self.postMessage({ type: 'LOG', message: `FFmpeg: Trying to load core from ${baseURL}...` });
          await ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          });
          loaded = true;
          break;
        } catch (e) {
          console.warn(`Failed to load from ${baseURL}, trying next...`);
        }
      }

      if (!loaded) throw new Error("All FFmpeg CDNs failed to load.");

      isLoaded = true;
      isLoading = false;
      self.postMessage({ type: 'INIT_SUCCESS', isLowRam });
    } catch (error: any) {
      isLoading = false;
      self.postMessage({ type: 'INIT_ERROR', error: error.message || String(error) });
    }
  }

  if (type === 'TRANSCODE') {
    const { file, targetFormat, fileId, options } = payload;
    
    try {
      if (!isLoaded && !isLoading) {
        // @ts-ignore
        await self.onmessage?.({ data: { type: 'INIT' } } as MessageEvent);
      }

      while (isLoading) await new Promise(r => setTimeout(r, 100));
      if (!isLoaded || !ffmpeg) throw new Error("FFmpeg failed to load.");

      const inputName = file.name;
      const extension = inputName.split('.').pop()?.toLowerCase();
      const outputName = `output.${targetFormat}`;
      
      const arrayBuffer = await file.arrayBuffer();
      await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));

      ffmpeg.on('progress', ({ progress }: { progress: number }) => {
        self.postMessage({ type: 'CONVERSION_PROGRESS', fileId, progress: Math.round(progress * 100) });
      });

      const args = [];
      if (options?.frameTimestamp !== undefined) {
        args.push('-ss', options.frameTimestamp.toString());
      } else if (options?.trimStart !== undefined) {
        args.push('-ss', options.trimStart.toString());
      }

      args.push('-i', inputName);

      if (options?.trimEnd !== undefined) {
        args.push('-to', options.trimEnd.toString());
      }

      const vFilters = [];
      if (options?.transparencyColor) {
        const color = options.transparencyColor.startsWith('#') ? options.transparencyColor : `#${options.transparencyColor}`;
        vFilters.push(`colorkey=${color}:${options.transparencySimilarity || 0.1}:${options.transparencyBlend || 0.1}`);
      }
      if (options?.crop) {
        const { width: w, height: h, x, y } = options.crop;
        vFilters.push(`crop=${w}:${h}:${x}:${y}`);
      }
      if (options?.resolution) {
        vFilters.push(`scale=${options.resolution.replace('x', ':')}`);
      }
      
      if (vFilters.length > 0) args.push('-vf', vFilters.join(','));
      if (options?.audioBitrate) args.push('-b:a', options.audioBitrate);

      if (options?.frameTimestamp !== undefined || targetFormat.match(/^(png|jpg|jpeg|webp)$/)) {
        if (!targetFormat.match(/gif/)) args.push('-vframes', '1');
      }

      args.push(outputName);

      self.postMessage({ type: 'LOG', message: `FFmpeg: Executing ${args.join(' ')}` });
      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const mimeTypes: { [key: string]: string } = {
        'mp4': 'video/mp4', 'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo',
        'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
        'ogg': 'audio/ogg', 'flac': 'audio/flac', 'gif': 'image/gif',
        'webp': 'image/webp', 'png': 'image/png', 'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg'
      };
      
      const blob = new Blob([data as any], { type: mimeTypes[targetFormat.toLowerCase()] || 'application/octet-stream' });

      self.postMessage({ 
        type: 'CONVERSION_SUCCESS', 
        fileId, 
        output: blob,
        fileName: `${file.name.split('.')[0]}.${targetFormat}`
      });

      // Cleanup
      if (extension === 'zip') {
        const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
        for (const path of Object.keys(unzipped)) {
           try { await ffmpeg.deleteFile(path); } catch (e) {}
        }
      } else {
        await ffmpeg.deleteFile(inputName);
      }
      await ffmpeg.deleteFile(outputName);
    } catch (error: any) {
      self.postMessage({ type: 'CONVERSION_ERROR', fileId, error: error.message || String(error) });
    }
  }
};
