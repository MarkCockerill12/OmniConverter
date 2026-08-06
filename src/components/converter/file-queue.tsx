"use client";

import { motion } from "framer-motion";
import {
  FileVideo, Box, X, Zap, ArrowRight, CircleDashed, CheckCircle2, Plus, AlertCircle, FileQuestion, Pencil,
  Download, FileArchive,
} from "lucide-react";
import { cn, is3DFile } from "@/lib/utils";
import { FormatDropdown, StatusBadge } from "@/components/converter/format-selector";
import { canConvert, getFileCategory, type EditOptions } from "@/lib/formats";
import { ArchiveInspector } from "@/components/converter/archive-inspector";
import type { Engine } from "@/lib/conversion";

export interface SelectedFile {
  file: File;
  targetFormat: string;
  id: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
  editOptions?: EditOptions;
  engine?: Engine;
  result?: { blob: Blob; fileName: string };
}

/** How each engine is labelled in the queue. */
const ENGINE_LABELS: Record<Engine, string> = {
  native: "Instant",
  webcodecs: "GPU",
  ffmpeg: "WASM",
  three: "3D",
  document: "DOC",
  archive: "PACK",
};

interface FileQueueProps {
  files: SelectedFile[];
  selected3DId: string | null;
  isConverting: boolean;
  isMediaReady: boolean;
  completedCount: number;
  editorTypeFor: (file: SelectedFile) => string | null;
  onSelect3D: (id: string) => void;
  onFormatChange: (id: string, format: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onAddMore: () => void;
  onConvertAll: () => void;
  onDownload: (id: string) => void;
  onDownloadAll: () => void;
}

function statusText(sf: SelectedFile) {
  if (sf.status === 'processing') return `Processing ${sf.progress}%`;
  if (sf.status === 'error') return sf.error || "Error";
  if (sf.status === 'completed' && sf.result) return `${(sf.result.blob.size / 1024).toFixed(0)} KB ready`;
  return `${(sf.file.size / 1024).toFixed(0)} KB`;
}

export function FileQueue({
  files,
  selected3DId,
  isConverting,
  isMediaReady,
  completedCount,
  editorTypeFor,
  onSelect3D,
  onFormatChange,
  onEdit,
  onRemove,
  onAddMore,
  onConvertAll,
  onDownload,
  onDownloadAll,
}: FileQueueProps) {
  return (
    <div className="p-6" data-omni="queue">
      <div className="space-y-3 mb-8">
        {files.map((sf) => {
          const supported = canConvert(sf.file.name);
          const isArchive = getFileCategory(sf.file.name) === "Archive" && supported;
          return (
            <div key={sf.id}>
            <motion.div
              onClick={() => { if (is3DFile(sf.file.name)) onSelect3D(sf.id); }}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex items-center justify-between p-4 bg-black/20 rounded-2xl border transition-all cursor-pointer",
                selected3DId === sf.id ? "border-[#e11d48] shadow-lg shadow-[#e11d48]/5" : "border-white/5 hover:border-white/10"
              )}
            >
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center border border-white/10 shrink-0">
                  {!supported ? (
                    <FileQuestion className="w-5 h-5 text-neutral-500" />
                  ) : is3DFile(sf.file.name) ? (
                    <Box className="w-5 h-5 text-purple-400" />
                  ) : (
                    <FileVideo className="w-5 h-5 text-blue-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-bold truncate pr-4 text-sm">{sf.file.name}</p>
                    {sf.status === 'processing' && <CircleDashed className="w-3 h-3 text-[#e11d48] animate-spin shrink-0" />}
                    {sf.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />}
                    {sf.status === 'error' && <AlertCircle className="w-3 h-3 text-[#e11d48] shrink-0" />}
                  </div>
                  <div className="flex items-center gap-2">
                    <p className={cn("text-[10px] font-black uppercase tracking-widest truncate", sf.status === 'error' ? "text-[#e11d48]" : "text-neutral-500")}>
                      {statusText(sf)}
                    </p>
                    {sf.engine && sf.status !== 'error' && (
                      <span
                        title={`Converted by the ${sf.engine} engine`}
                        className={cn(
                          "text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0",
                          sf.engine === 'webcodecs' || sf.engine === 'native'
                            ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                            : "text-neutral-500 border-white/10 bg-white/5"
                        )}
                      >
                        {ENGINE_LABELS[sf.engine]}
                      </span>
                    )}
                  </div>
                  {sf.status === 'processing' && (
                    <div className="mt-1.5 h-0.5 w-full max-w-[220px] bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-[#e11d48] transition-all duration-200" style={{ width: `${sf.progress}%` }} />
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded border border-white/10 text-[10px] font-black uppercase tracking-widest">{sf.file.name.split('.').pop()?.toUpperCase()}</div>
                  {!supported ? (
                    <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded border border-white/5 text-[10px] font-black uppercase tracking-widest text-neutral-500">Unsupported</div>
                  ) : (
                    <>
                      <ArrowRight className="w-4 h-4 text-neutral-600" />
                      <FormatDropdown value={sf.targetFormat} onChange={(val) => onFormatChange(sf.id, val)} sourceFileName={sf.file.name} />
                      {editorTypeFor(sf) && (
                        <button
                          onClick={() => onEdit(sf.id)}
                          title={sf.editOptions ? "Modify edits" : "Edit media"}
                          className={cn(
                            "p-2.5 rounded-lg border transition-all flex items-center justify-center hover:scale-105 active:scale-95",
                            sf.editOptions
                              ? "bg-[#e11d48]/20 border-[#e11d48] text-[#e11d48]"
                              : "bg-white/5 border-white/10 text-neutral-400 hover:text-white hover:border-white/20"
                          )}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 border-l border-white/10 pl-6">
                  {sf.result && (
                    <button
                      title={`Download ${sf.result.fileName}`}
                      className="p-2 hover:bg-emerald-500/10 rounded-lg transition-colors text-emerald-500"
                      onClick={() => onDownload(sf.id)}
                    >
                      <Download className="w-5 h-5" />
                    </button>
                  )}
                  <button className="p-2 hover:bg-white/5 rounded-lg transition-colors text-neutral-500 hover:text-[#e11d48]" onClick={() => onRemove(sf.id)}><X className="w-5 h-5" /></button>
                </div>
              </div>
            </motion.div>
            {isArchive && <ArchiveInspector file={sf.file} />}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-6 border-t border-white/5 gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <button onClick={onAddMore} disabled={isConverting} className="flex items-center gap-2 px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all disabled:opacity-50"><Plus className="w-4 h-4" /> Add More</button>
          <StatusBadge label="Engine" ready={isMediaReady} />
        </div>
        <div className="flex items-center gap-3">
          {completedCount > 0 && (
            <button
              onClick={onDownloadAll}
              className="flex items-center gap-2 px-6 py-4 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-sm font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-900/30 active:scale-95"
            >
              <FileArchive className="w-4 h-4" />
              {completedCount > 1 ? `Download all (${completedCount})` : "Download"}
            </button>
          )}
          <button onClick={onConvertAll} disabled={isConverting || files.every(f => !f.targetFormat)} className="px-12 py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-xl font-black text-lg shadow-xl shadow-[#e11d48]/20 flex items-center gap-3 group transition-all disabled:opacity-50 disabled:grayscale">
            {isConverting ? "CONVERTING..." : "CONVERT ALL"}
            <Zap className={cn("w-5 h-5 fill-white group-hover:scale-125 transition-transform", isConverting && "animate-pulse")} />
          </button>
        </div>
      </div>
    </div>
  );
}
