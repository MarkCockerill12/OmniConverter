"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

export type WorkerKind = "media" | "scraper" | "nintendo";

/**
 * Workers are expensive singletons (the media worker alone streams a ~30 MB
 * FFmpeg core). They are cached per document and shared by every consumer, so
 * mounting the viewer next to the converter no longer spawns duplicates.
 */
const registry = new Map<WorkerKind, Worker>();

function spawn(kind: WorkerKind): Worker {
  switch (kind) {
    case "media": {
      const worker = new Worker(new URL("../workers/media.worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (e: MessageEvent) => {
        if (e.data?.type === "INIT_SUCCESS") {
          useStore.getState().setMediaReady(true);
          useStore.getState().setLowRam(!!e.data.isLowRam);
        }
      });
      worker.postMessage({ type: "INIT" });
      return worker;
    }
    case "scraper": {
      const worker = new Worker(new URL("../workers/scraper.worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (e: MessageEvent) => {
        if (e.data?.type === "INIT_SUCCESS") useStore.getState().setScraperReady(true);
      });
      worker.postMessage({
        type: "INIT",
        payload: { proxyUrl: process.env.NEXT_PUBLIC_SCRAPER_API_URL || "/api/extract" },
      });
      return worker;
    }
    case "nintendo":
      return new Worker(new URL("../workers/nintendo.worker.ts", import.meta.url), { type: "module" });
  }
}

export function getWorker(kind: WorkerKind): Worker | null {
  if (typeof window === "undefined") return null;
  let worker = registry.get(kind);
  if (!worker) {
    worker = spawn(kind);
    registry.set(kind, worker);
  }
  return worker;
}

/**
 * Returns the requested workers, creating them on first use. Workers live for
 * the lifetime of the tab, so they are intentionally never terminated here.
 */
export function useWorkers(...kinds: WorkerKind[]) {
  const [workers, setWorkers] = useState<Partial<Record<WorkerKind, Worker | null>>>({});
  const key = kinds.join(",");

  useEffect(() => {
    const next: Partial<Record<WorkerKind, Worker | null>> = {};
    for (const kind of key.split(",") as WorkerKind[]) next[kind] = getWorker(kind);
    setWorkers(next);
  }, [key]);

  return {
    mediaWorker: workers.media ?? null,
    scraperWorker: workers.scraper ?? null,
    nintendoWorker: workers.nintendo ?? null,
  };
}
