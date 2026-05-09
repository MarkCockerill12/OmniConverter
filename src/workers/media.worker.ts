/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

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
    // Device Memory Check for Low RAM Environments
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
      
      // Use UMD version of core for consistency and easy CDN access
      // Standard core (non-mt) is used for maximum compatibility
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
      
      self.postMessage({ type: 'LOG', message: "FFmpeg: Loading core from CDN..." });

      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      isLoaded = true;
      isLoading = false;
      self.postMessage({ type: 'INIT_SUCCESS', isLowRam });
      self.postMessage({ type: 'LOG', message: "FFmpeg: Ready" });
    } catch (error: any) {
      isLoading = false;
      const errorMsg = error.message || String(error);
      self.postMessage({ type: 'INIT_ERROR', error: errorMsg });
      self.postMessage({ type: 'LOG', message: `FFmpeg Load Error: ${errorMsg}` });
    }
  }

  if (type === 'TRANSCODE') {
    const { file, targetFormat, fileId } = payload;
    
    try {
      if (!isLoaded && !isLoading) {
        // Automatically try to init if not loaded
        await self.onmessage({ data: { type: 'INIT' } } as MessageEvent);
      }

      // Wait if still loading from a concurrent request
      while (isLoading) {
        await new Promise(r => setTimeout(r, 100));
      }

      if (!isLoaded || !ffmpeg) throw new Error("FFmpeg failed to load.");

      const inputName = file.name;
      const outputName = `output.${targetFormat}`;
      
      const arrayBuffer = await file.arrayBuffer();
      await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));

      ffmpeg.on('progress', ({ progress }: { progress: number }) => {
        self.postMessage({ 
          type: 'CONVERSION_PROGRESS', 
          fileId, 
          progress: Math.round(progress * 100) 
        });
      });

      await ffmpeg.exec(['-i', inputName, outputName]);

      const data = await ffmpeg.readFile(outputName);
      const mimeTypes: { [key: string]: string } = {
        'mp4': 'video/mp4', 'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo',
        'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
        'ogg': 'audio/ogg', 'flac': 'audio/flac', 'gif': 'image/gif',
        'webp': 'image/webp', 'png': 'image/png', 'jpg': 'image/jpeg'
      };
      
      const mimeType = mimeTypes[targetFormat.toLowerCase()] || 'application/octet-stream';
      const blob = new Blob([data as any], { type: mimeType });

      self.postMessage({ 
        type: 'CONVERSION_SUCCESS', 
        fileId, 
        output: blob,
        fileName: `${file.name.split('.')[0]}.${targetFormat}`
      });

      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (error: any) {
      self.postMessage({ type: 'CONVERSION_ERROR', fileId, error: error.message || String(error) });
    }
  }
};
