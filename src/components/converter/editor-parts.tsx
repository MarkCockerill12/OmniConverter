"use client";

import { useState } from "react";
import { cn, formatTime, parseTime } from "@/lib/utils";

/** Shared building blocks for the editor control rails. */

export const FIELD_CLASS =
  "w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors";
export const LABEL_CLASS = "text-[10px] font-black uppercase tracking-widest text-neutral-500 min-w-0 break-words";
export const HINT_CLASS = "text-[9px] text-neutral-500 font-medium italic";

export function EditorSection({ title, icon, children }: { title: string, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-[#e11d48]">
        <div className="p-2 bg-[#e11d48]/10 rounded-lg">
          {icon}
        </div>
        <h4 className="text-[12px] font-black uppercase tracking-[0.2em] min-w-0 truncate">{title}</h4>
      </div>
      <div className="pl-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, suffix = "", disabled, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className={LABEL_CLASS}>{label}</label>
        <span className="text-[10px] font-mono font-black text-[#e11d48] shrink-0">{value}{suffix}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} disabled={disabled} aria-label={label}
        className="w-full accent-[#e11d48] disabled:opacity-30"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer group">
      <input type="checkbox" className="w-4 h-4 shrink-0 accent-[#e11d48]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400 group-hover:text-white transition-colors min-w-0 break-words">{label}</span>
    </label>
  );
}

/** A segmented row of mutually exclusive choices. */
export function Choice<T extends string | number>({ value, options, columns = 4, onChange }: {
  value: T | undefined;
  options: { id: T; label: string; title?: string }[];
  columns?: number;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={String(option.id)}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            "py-3 px-1 min-w-0 truncate rounded-xl text-[10px] font-black uppercase tracking-wide border transition-all",
            value === option.id
              ? "bg-[#e11d48] border-[#e11d48] text-white shadow-lg shadow-[#e11d48]/20"
              : "bg-black/40 border-white/10 text-neutral-500 hover:border-white/20"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A time field: shows m:ss, accepts "1:30" or plain seconds while typing. */
export function TimeField({ label, value, onChange }: { label: string; value: number; onChange: (seconds: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="space-y-1.5 min-w-0">
      <label className={LABEL_CLASS}>{label}</label>
      <input
        type="text" inputMode="decimal" aria-label={label} placeholder="0:00"
        className={cn(FIELD_CLASS, "font-mono")}
        value={draft ?? formatTime(value, 2)}
        onChange={(e) => {
          setDraft(e.target.value);
          const seconds = parseTime(e.target.value);
          if (seconds !== null) onChange(seconds);
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

export function GhostButton({ children, onClick, active, title, disabled, stacked }: {
  children: React.ReactNode; onClick: () => void; active?: boolean; title?: string; disabled?: boolean;
  /** Icon above the label, for narrow grids. */
  stacked?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "py-3 px-2 min-w-0 border rounded-xl text-[10px] font-black uppercase tracking-wide text-center leading-tight transition-all flex items-center justify-center gap-2 disabled:opacity-30",
        stacked && "flex-col gap-1.5 text-[9px]",
        active
          ? "bg-[#e11d48] border-[#e11d48] text-white shadow-lg shadow-[#e11d48]/20"
          : "bg-white/5 border-white/10 text-neutral-400 hover:bg-white/10 hover:border-white/20 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}
