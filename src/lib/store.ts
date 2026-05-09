import { create } from 'zustand';

interface WorkerState {
  isMediaReady: boolean;
  isScraperReady: boolean;
  isBinaryReady: boolean;
  isLowRam: boolean;
  setMediaReady: (ready: boolean) => void;
  setScraperReady: (ready: boolean) => void;
  setBinaryReady: (ready: boolean) => void;
  setLowRam: (lowRam: boolean) => void;
}

export const useStore = create<WorkerState>((set) => ({
  isMediaReady: false,
  isScraperReady: false,
  isBinaryReady: false,
  isLowRam: false,
  setMediaReady: (ready) => set({ isMediaReady: ready }),
  setScraperReady: (ready) => set({ isScraperReady: ready }),
  setBinaryReady: (ready) => set({ isBinaryReady: ready }),
  setLowRam: (lowRam) => set({ isLowRam: lowRam }),
}));
