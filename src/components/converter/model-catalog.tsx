"use client";

import { Check, Crosshair, Eye, EyeOff, Layers, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CatalogModel {
  id: string;
  name: string;
  sourceName: string;
  visible: boolean;
}

interface ModelCatalogProps {
  models: CatalogModel[];
  selectedId: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (id: string) => void;
  onSelect: (id: string | null) => void;
  onSetAll: (visible: boolean) => void;
}

/**
 * Viewport overlay listing every model found in the dropped files. The tick
 * controls what the viewport shows — and therefore what an export contains —
 * while the crosshair picks the model the transform gizmo moves.
 */
export function ModelCatalog({
  models,
  selectedId,
  isOpen,
  onOpenChange,
  onToggle,
  onSelect,
  onSetAll,
}: ModelCatalogProps) {
  if (models.length === 0) return null;
  const visibleCount = models.filter((m) => m.visible).length;

  return (
    <div className="absolute top-4 right-4 z-50 flex flex-col items-end gap-2">
      <button
        onClick={() => onOpenChange(!isOpen)}
        className={cn(
          "p-3 rounded-xl backdrop-blur-xl border transition-all shadow-2xl flex items-center gap-3",
          isOpen ? "bg-[#e11d48] border-[#e11d48] text-white" : "bg-[#1f2228]/95 border-white/10 text-neutral-400 hover:text-white"
        )}
      >
        <Layers className="w-4 h-4" />
        <span className="text-[10px] font-black uppercase tracking-widest pr-1">
          Models ({visibleCount}/{models.length})
        </span>
      </button>

      {isOpen && (
        <div className="w-72 bg-[#1f2228]/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="p-3 border-b border-white/5 bg-white/5 flex items-center justify-between">
            <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Mesh Catalog</p>
            <button onClick={() => onOpenChange(false)} className="text-neutral-500 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
            <button
              onClick={() => onSetAll(true)}
              className="flex-1 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[9px] font-black uppercase tracking-widest text-neutral-300 transition-colors"
            >
              Show all
            </button>
            <button
              onClick={() => onSetAll(false)}
              className="flex-1 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[9px] font-black uppercase tracking-widest text-neutral-300 transition-colors"
            >
              Hide all
            </button>
          </div>

          <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
            {models.map((model) => (
              <div
                key={model.id}
                className={cn(
                  "w-full flex items-center gap-2 p-3 border-b border-white/5 last:border-0 transition-colors",
                  selectedId === model.id ? "bg-purple-600/15" : "hover:bg-white/5"
                )}
              >
                <button onClick={() => onToggle(model.id)} title="Show or hide in the viewport" className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  <div
                    className={cn(
                      "w-4 h-4 rounded border flex items-center justify-center transition-all shrink-0",
                      model.visible ? "bg-emerald-500 border-emerald-500 text-white" : "border-white/20 text-transparent"
                    )}
                  >
                    <Check className="w-3 h-3 stroke-[4px]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-xs font-bold truncate", model.visible ? "text-white" : "text-neutral-500")}>{model.name}</p>
                    <p className="text-[8px] font-black uppercase tracking-tighter text-neutral-600 truncate">{model.sourceName}</p>
                  </div>
                  {model.visible ? <Eye className="w-3.5 h-3.5 text-emerald-500" /> : <EyeOff className="w-3.5 h-3.5 text-neutral-600" />}
                </button>
                <button
                  onClick={() => onSelect(selectedId === model.id ? null : model.id)}
                  title="Select for the transform gizmo"
                  disabled={!model.visible}
                  className={cn(
                    "p-1.5 rounded-lg shrink-0 transition-all",
                    selectedId === model.id ? "bg-purple-600 text-white" : "text-neutral-500 hover:text-white hover:bg-white/10",
                    !model.visible && "opacity-20 pointer-events-none"
                  )}
                >
                  <Crosshair className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
