"use client";

import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { Upload, ChevronDown } from "lucide-react";
import { useWorkers, getWorker } from "@/hooks/use-workers";
import { useStore } from "@/lib/store";
import { cn, downloadBlob, is3DFile, stripExtension } from "@/lib/utils";
import { getFileCategory, canConvert, type EditOptions } from "@/lib/formats";
import { convertFile, type Engine } from "@/lib/conversion";
import { FileQueue, type SelectedFile } from "@/components/converter/file-queue";
import { ForgePanel } from "@/components/converter/forge-panel";
import { MediaEditorModal, type EditorType } from "@/components/converter/media-editors";
import { loadQueue, saveQueue, type StoredJob } from "@/lib/storage";

const TRANSCODE_TIMEOUT_MS = 600_000;
/** Jobs run concurrently; the FFmpeg worker serialises its own share internally. */
const MAX_CONCURRENCY = 3;

export default function Home() {
  const { mediaWorker } = useWorkers("media");
  const { isMediaReady } = useStore();

  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [selected3DId, setSelected3DId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  const patchFile = useCallback((id: string, patch: Partial<SelectedFile>) => {
    setSelectedFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  // Restore the queue saved by the previous session.
  useEffect(() => {
    (async () => {
      const jobs = await loadQueue();
      restored.current = true;
      if (jobs.length === 0) return;
      setSelectedFiles(jobs.map(job => ({
        file: job.file,
        targetFormat: job.targetFormat,
        id: job.id,
        status: 'idle' as const,
        progress: 0,
        editOptions: job.editOptions,
      })));
      const first3D = jobs.find(job => is3DFile(job.file.name));
      if (first3D) setSelected3DId(first3D.id);
    })();
  }, []);

  // Persist it again whenever it changes (results themselves are not stored).
  useEffect(() => {
    if (!restored.current) return;
    const jobs: StoredJob[] = selectedFiles.map((sf, index) => ({
      id: sf.id,
      file: sf.file,
      targetFormat: sf.targetFormat,
      editOptions: sf.editOptions,
      addedAt: index,
    }));
    const timer = setTimeout(() => { saveQueue(jobs); }, 400);
    return () => clearTimeout(timer);
  }, [selectedFiles]);

  const getEditorType = (sf: SelectedFile): EditorType | null => {
    const category = getFileCategory(sf.file.name);
    const targetCategory = sf.targetFormat ? getFileCategory(`dummy.${sf.targetFormat}`) : "";

    if (category === "Video" && targetCategory === "Image") return "video-to-image";
    if ((category === "Video" || category === "Audio") && targetCategory === "Audio") return "audio";
    if (category === "Image") return "image";
    if (category === "Video") return "video";
    if (category === "Audio") return "audio";
    return null;
  };

  const addFiles = (files: FileList | File[]) => {
    const newFiles: SelectedFile[] = Array.from(files).map(file => ({
      file,
      targetFormat: "",
      id: crypto.randomUUID(),
      status: 'idle',
      progress: 0,
    }));

    setSelectedFiles(prev => {
      const updated = [...prev, ...newFiles];
      if (!updated.some(sf => sf.id === selected3DId)) {
        const first3D = updated.find(sf => is3DFile(sf.file.name));
        if (first3D) setSelected3DId(first3D.id);
      }
      return updated;
    });
  };

  const removeFile = (id: string) => {
    setSelectedFiles(prev => {
      const updated = prev.filter(f => f.id !== id);
      if (selected3DId === id) setSelected3DId(updated.find(sf => is3DFile(sf.file.name))?.id ?? null);
      return updated;
    });
  };

  /** Bridges a single job to the FFmpeg worker. */
  const runFfmpeg = useCallback((
    id: string,
    payload: { file: File; target: string; options: EditOptions; onProgress: (percent: number) => void }
  ) => new Promise<Blob>((resolve, reject) => {
    if (!mediaWorker) return reject(new Error("Media engine is not ready yet."));
    const cleanup = () => {
      mediaWorker.removeEventListener('message', handler);
      clearTimeout(timeout);
    };
    const handler = (e: MessageEvent) => {
      if (e.data.fileId !== id) return;
      if (e.data.type === 'CONVERSION_PROGRESS') {
        payload.onProgress(e.data.progress);
      } else if (e.data.type === 'CONVERSION_ERROR') {
        cleanup();
        reject(new Error(e.data.error || "Conversion failed"));
      } else if (e.data.type === 'CONVERSION_SUCCESS') {
        cleanup();
        resolve(e.data.output as Blob);
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Conversion timed out"));
    }, TRANSCODE_TIMEOUT_MS);

    mediaWorker.addEventListener('message', handler);
    mediaWorker.postMessage({
      type: 'TRANSCODE',
      payload: { file: payload.file, targetFormat: payload.target, fileId: id, options: payload.options },
    });
  }), [mediaWorker]);

  const runJob = useCallback(async (sf: SelectedFile, autoDownload: boolean) => {
    if (!canConvert(sf.file.name)) {
      patchFile(sf.id, { status: 'error', error: `${getFileCategory(sf.file.name)} conversion is not supported yet.` });
      return;
    }

    patchFile(sf.id, { status: 'processing', error: undefined, progress: 0, result: undefined });
    try {
      const result = await convertFile({
        file: sf.file,
        target: sf.targetFormat,
        options: sf.editOptions,
        nintendoWorker: getWorker("nintendo"),
        ffmpeg: (payload) => runFfmpeg(sf.id, payload),
        onProgress: (percent) => patchFile(sf.id, { progress: percent }),
        onEngine: (engine: Engine) => patchFile(sf.id, { engine }),
      });
      patchFile(sf.id, { status: 'completed', progress: 100, result });
      if (autoDownload) downloadBlob(result.blob, result.fileName);
    } catch (err: any) {
      console.error(`[Main] Conversion failed for ${sf.file.name}:`, err);
      patchFile(sf.id, { status: 'error', error: err?.message || "Conversion failed" });
    }
  }, [patchFile, runFfmpeg]);

  const handleConvertAll = async () => {
    const pending = selectedFiles.filter(f => f.targetFormat && f.status !== 'completed');
    if (pending.length === 0) return;
    setIsConverting(true);

    // A single job downloads straight away; batches are collected so the
    // browser is not asked to save several files at once.
    const autoDownload = pending.length === 1;
    let cursor = 0;
    const lanes = Array.from({ length: Math.min(MAX_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const job = pending[cursor++];
        await runJob(job, autoDownload);
      }
    });
    await Promise.all(lanes);
    setIsConverting(false);
  };

  const completed = selectedFiles.filter(sf => sf.result);

  const downloadAll = async () => {
    if (completed.length === 0) return;
    if (completed.length === 1) {
      downloadBlob(completed[0].result!.blob, completed[0].result!.fileName);
      return;
    }
    const { zipSync } = await import("fflate");
    const entries: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    for (const sf of completed) {
      let name = sf.result!.fileName;
      let counter = 2;
      while (used.has(name)) {
        name = `${stripExtension(sf.result!.fileName)}_${counter++}.${sf.result!.fileName.split('.').pop()}`;
      }
      used.add(name);
      entries[name] = new Uint8Array(await sf.result!.blob.arrayBuffer());
    }
    downloadBlob(new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: "application/zip" }), `omni_converted_${Date.now()}.zip`);
  };

  const has3D = useMemo(() => selectedFiles.some(sf => is3DFile(sf.file.name)), [selectedFiles]);
  const editingFile = selectedFiles.find(f => f.id === editingFileId);

  return (
    <main className="max-w-[1400px] mx-auto px-6 py-12">
      {/* Hero */}
      <section className="text-center mb-16">
        <h1 className="text-5xl md:text-8xl font-black tracking-tighter mb-6 leading-none uppercase">
          Convert <span className="text-[#e11d48]">Any</span> File.
        </h1>
      </section>

      {/* Converter App */}
      <section className="relative max-w-[1000px] mx-auto">
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files) addFiles(e.dataTransfer.files); }}
          className={cn(
            "bg-[#1f2228] rounded-3xl border border-white/10 shadow-2xl transition-all duration-300",
            isDragging && "border-[#e11d48] scale-[1.01] bg-[#262a32]"
          )}
        >
          {selectedFiles.length > 0 ? (
            <FileQueue
              files={selectedFiles}
              selected3DId={selected3DId}
              isConverting={isConverting}
              isMediaReady={isMediaReady}
              completedCount={completed.length}
              editorTypeFor={getEditorType}
              onSelect3D={setSelected3DId}
              onFormatChange={(id, format) => patchFile(id, { targetFormat: format, status: 'idle', result: undefined, error: undefined })}
              onEdit={setEditingFileId}
              onRemove={removeFile}
              onAddMore={() => fileInputRef.current?.click()}
              onConvertAll={handleConvertAll}
              onDownload={(id) => {
                const sf = selectedFiles.find(f => f.id === id);
                if (sf?.result) downloadBlob(sf.result.blob, sf.result.fileName);
              }}
              onDownloadAll={downloadAll}
            />
          ) : (
            <div onClick={() => fileInputRef.current?.click()} className="p-32 flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-24 h-24 bg-white/5 rounded-[2rem] border border-white/10 flex items-center justify-center mb-8 group-hover:scale-110 group-hover:bg-[#e11d48] group-hover:border-[#e11d48] transition-all duration-500 shadow-2xl"><Upload className="w-10 h-10 text-neutral-400 group-hover:text-white" /></div>
              <h2 className="text-3xl font-black tracking-tight mb-2 uppercase">Drop your files</h2>
              <p className="text-neutral-500 font-bold mb-10 tracking-widest uppercase text-xs">or click to browse the system.</p>
              <button className="px-10 py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-xl font-black text-lg shadow-xl shadow-[#e11d48]/20 flex items-center gap-3 transition-all">SELECT FILE <ChevronDown className="w-4 h-4" /></button>
            </div>
          )}
        </div>
        <input
          type="file"
          ref={fileInputRef}
          multiple
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
          className="hidden"
        />
      </section>

      {/* Media Editor Modal */}
      {editingFile && (
        <MediaEditorModal
          isOpen
          onClose={() => setEditingFileId(null)}
          file={editingFile.file}
          type={getEditorType(editingFile) as EditorType}
          targetFormat={editingFile.targetFormat}
          initialOptions={editingFile.editOptions}
          onSave={(options: EditOptions, target?: string) =>
            patchFile(editingFile.id, { editOptions: options, ...(target ? { targetFormat: target } : {}) })
          }
        />
      )}

      {/* 3D Forge Section */}
      <AnimatePresence>
        {has3D && (
          <ForgePanel files={selectedFiles} selected3DId={selected3DId} onSelect3D={setSelected3DId} />
        )}
      </AnimatePresence>
    </main>
  );
}
