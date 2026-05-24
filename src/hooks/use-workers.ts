"use client";

import { useEffect, useRef } from 'react';
import { useStore } from '@/lib/store';

export function useWorkers() {
  const mediaWorker = useRef<Worker | null>(null);
  const scraperWorker = useRef<Worker | null>(null);
  const binaryWorker = useRef<Worker | null>(null);
  
  const { 
    setMediaReady, 
    setScraperReady, 
    setBinaryReady, 
    setLowRam 
  } = useStore();

  useEffect(() => {
    // Initialize Media Worker
    mediaWorker.current = new Worker(
      new URL('../workers/media.worker.ts', import.meta.url),
      { type: 'module' }
    );
    mediaWorker.current.onmessage = (e) => {
      if (e.data.type === 'LOG') console.log('[Media Worker]', e.data.message);
      if (e.data.type === 'INIT_SUCCESS') {
        setMediaReady(true);
        setLowRam(e.data.isLowRam);
      }
      if (e.data.type === 'INIT_ERROR') {
        console.error('[Media Worker] Init Failed:', e.data.error);
      }
    };

    // Initialize Scraper Worker
    scraperWorker.current = new Worker(
      new URL('../workers/scraper.worker.ts', import.meta.url)
    );
    scraperWorker.current.onmessage = (e) => {
      if (e.data.type === 'INIT_SUCCESS') setScraperReady(true);
      if (e.data.type === 'LOG') console.log('[Scraper Worker]', e.data.message);
      if (e.data.type === 'SCRAPE_SUCCESS') setScraperReady(true); // Auto-ready on first success
    };

    // Initialize Binary Worker
    binaryWorker.current = new Worker(
      new URL('../workers/binary.worker.ts', import.meta.url)
    );
    binaryWorker.current.onmessage = (e) => {
      if (e.data.type === 'PARSE_SUCCESS') setBinaryReady(true);
    };

    return () => {
      mediaWorker.current?.terminate();
      scraperWorker.current?.terminate();
      binaryWorker.current?.terminate();
    };
  }, [setMediaReady, setScraperReady, setBinaryReady, setLowRam]);

  return {
    mediaWorker: mediaWorker.current,
    scraperWorker: scraperWorker.current,
    binaryWorker: binaryWorker.current,
  };
}
