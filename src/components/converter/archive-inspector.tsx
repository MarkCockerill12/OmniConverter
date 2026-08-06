"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FolderTree, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ArchiveEntryInfo } from "@/lib/conversion/archives";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Expandable listing of everything inside a ZIP/TAR/GZ, read in the browser. */
export function ArchiveInspector({ file }: { file: File }) {
  const [entries, setEntries] = useState<ArchiveEntryInfo[] | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (isOpen) return setIsOpen(false);
    setIsOpen(true);
    if (entries || isLoading) return;

    setIsLoading(true);
    try {
      const { inspectArchive } = await import("@/lib/conversion/archives");
      setEntries(await inspectArchive(file));
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Could not read this archive.");
    } finally {
      setIsLoading(false);
    }
  };

  const totalSize = entries?.reduce((sum, entry) => sum + entry.size, 0) ?? 0;

  return (
    <div className="mt-2">
      <button
        onClick={toggle}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[9px] font-black uppercase tracking-widest transition-all",
          isOpen ? "bg-white/10 border-white/20 text-white" : "bg-white/5 border-white/10 text-neutral-500 hover:text-white"
        )}
      >
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderTree className="w-3 h-3" />}
        {entries ? `${entries.length} entries · ${formatSize(totalSize)}` : "Inspect archive"}
      </button>

      <AnimatePresence>
        {isOpen && (entries || error) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2 max-h-[180px] overflow-y-auto custom-scrollbar rounded-xl border border-white/5 bg-black/30">
              {error ? (
                <p className="p-3 text-[10px] font-bold text-[#e11d48]">{error}</p>
              ) : (
                entries!.map((entry) => (
                  <div key={entry.path} className="flex items-center justify-between gap-4 px-3 py-1.5 border-b border-white/5 last:border-0">
                    <span className="text-[10px] font-mono text-neutral-300 truncate">{entry.path}</span>
                    <span className="text-[9px] font-black uppercase tracking-widest text-neutral-600 shrink-0">{formatSize(entry.size)}</span>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
