"use client";

import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SceneStats } from "@/lib/3d-materials";

export interface AnimationClipInfo {
  name: string;
  duration: number;
}

interface AnimationBarProps {
  clips: AnimationClipInfo[];
  activeClip: string | null;
  time: number;
  isPlaying: boolean;
  onSelect: (name: string) => void;
  onToggle: () => void;
  onSeek: (time: number) => void;
}

/** Playback strip shown only when the loaded models carry animation clips. */
export function AnimationBar({ clips, activeClip, time, isPlaying, onSelect, onToggle, onSeek }: AnimationBarProps) {
  if (clips.length === 0) return null;
  const current = clips.find((c) => c.name === activeClip) || clips[0];
  const duration = current?.duration || 1;

  return (
    <div className="absolute bottom-32 left-8 right-8 z-30 flex items-center gap-4 p-4 bg-[#1f2228]/90 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl pointer-events-auto">
      <button
        onClick={onToggle}
        title={isPlaying ? "Pause animation" : "Play animation"}
        className="w-10 h-10 bg-purple-600 hover:bg-purple-500 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95"
      >
        {isPlaying ? <Pause className="w-4 h-4 fill-white text-white" /> : <Play className="w-4 h-4 fill-white text-white ml-0.5" />}
      </button>

      {clips.length > 1 ? (
        <select
          value={activeClip || clips[0].name}
          onChange={(e) => onSelect(e.target.value)}
          className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-widest outline-none focus:border-purple-500 max-w-[160px]"
        >
          {clips.map((clip) => (
            <option key={clip.name} value={clip.name}>{clip.name}</option>
          ))}
        </select>
      ) : (
        <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400 truncate max-w-[160px]">{current?.name}</span>
      )}

      <input
        type="range"
        min={0}
        max={duration}
        step={Math.max(0.001, duration / 500)}
        value={Math.min(time % duration, duration)}
        onChange={(e) => onSeek(parseFloat(e.target.value))}
        className="flex-1 accent-purple-500"
      />
      <span className="text-[10px] font-mono font-bold text-neutral-400 shrink-0 w-24 text-right">
        {(time % duration).toFixed(2)}s / {duration.toFixed(2)}s
      </span>
    </div>
  );
}

interface StatsBarProps {
  fileCount: number;
  nodeCount: number;
  stats: SceneStats | null;
  environment: string;
}

/** Bottom read-out: workspace summary plus live geometry counts. */
export function StatsBar({ fileCount, nodeCount, stats, environment }: StatsBarProps) {
  const readouts: { label: string; value: string; accent?: boolean }[] = [
    { label: "Nodes", value: String(nodeCount), accent: true },
    { label: "Tris", value: stats ? stats.triangles.toLocaleString() : "0" },
    { label: "Verts", value: stats ? stats.vertices.toLocaleString() : "0" },
    { label: "Tex", value: stats ? String(stats.textures) : "0" },
    { label: "Environment", value: environment },
  ];

  return (
    <div className="absolute bottom-8 left-8 right-8 flex items-center justify-between p-5 bg-[#1f2228]/90 backdrop-blur-xl rounded-2xl border border-white/10 pointer-events-none shadow-2xl z-20 gap-6">
      <div className="flex items-center gap-5 min-w-0">
        <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.5)] shrink-0" />
        <div className="flex flex-col min-w-0">
          <p className="text-xs font-black text-white uppercase tracking-wider">Active Workspace</p>
          <p className="text-[10px] font-bold text-neutral-400 italic truncate max-w-[300px]">
            {fileCount > 0 ? `${fileCount} Files Active` : "Waiting..."}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-5 shrink-0">
        {readouts.map((readout, index) => (
          <div key={readout.label} className="flex items-center gap-5">
            {index > 0 && <div className="h-8 w-px bg-white/10" />}
            <div className="flex flex-col items-end">
              <p className="text-[10px] font-black uppercase text-neutral-500 tracking-widest">{readout.label}</p>
              <p className={cn(
                "text-xs font-black uppercase",
                readout.accent ? "text-[#e11d48] text-sm" : readout.label === "Environment" ? "text-emerald-500" : "text-white"
              )}>
                {readout.value}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
