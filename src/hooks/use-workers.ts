"use client";

import { useEffect, useState, useRef } from 'react';
import { useStore } from '@/lib/store';

export function useWorkers() {
  const [workers, setWorkers] = useState<{
    mediaWorker: Worker | null;
    scraperWorker: Worker | null;
    binaryWorker: Worker | null;
    nintendoWorker: Worker | null;
  }>({
    mediaWorker: null,
    scraperWorker: null,
    binaryWorker: null,
    nintendoWorker: null,
  });

  const { 
    setMediaReady, 
    setScraperReady, 
    setBinaryReady, 
    setLowRam 
  } = useStore();

  useEffect(() => {
    // 1. Media Worker
    const mw = new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' });
    mw.onmessage = (e) => {
      if (e.data.type === 'INIT_SUCCESS') { setMediaReady(true); setLowRam(e.data.isLowRam); }
    };
    mw.postMessage({ type: 'INIT' });

    // 2. Scraper Worker
    const sw = new Worker(new URL('../workers/scraper.worker.ts', import.meta.url));
    sw.onmessage = (e) => { if (e.data.type === 'INIT_SUCCESS') setScraperReady(true); };
    const proxyUrl = process.env.NEXT_PUBLIC_SCRAPER_API_URL || '/api/extract';
    sw.postMessage({ type: 'INIT', payload: { proxyUrl } });

    // 3. Binary Worker
    const bw = new Worker(new URL('../workers/binary.worker.ts', import.meta.url));
    bw.onmessage = (e) => { if (e.data.type === 'PARSE_SUCCESS') setBinaryReady(true); };

    // 4. Nintendo Worker
    const nw = new Worker(new URL('../workers/nintendo.worker.ts', import.meta.url), { type: 'module' });

    setWorkers({
      mediaWorker: mw,
      scraperWorker: sw,
      binaryWorker: bw,
      nintendoWorker: nw,
    });

    return () => {
      mw.terminate();
      sw.terminate();
      bw.terminate();
      nw.terminate();
    };
  }, [setMediaReady, setScraperReady, setBinaryReady, setLowRam]);

  return workers;
}
