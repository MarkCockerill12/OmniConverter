import { create } from 'zustand';

interface WorkerState {
  isMediaReady: boolean;
  isScraperReady: boolean;
  isLowRam: boolean;
  setMediaReady: (ready: boolean) => void;
  setScraperReady: (ready: boolean) => void;
  setLowRam: (lowRam: boolean) => void;
}

export const useStore = create<WorkerState>((set) => ({
  isMediaReady: false,
  isScraperReady: false,
  isLowRam: false,
  setMediaReady: (ready) => set({ isMediaReady: ready }),
  setScraperReady: (ready) => set({ isScraperReady: ready }),
  setLowRam: (lowRam) => set({ isLowRam: lowRam }),
}));
