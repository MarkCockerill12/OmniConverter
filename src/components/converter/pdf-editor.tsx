"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CircleDashed, FileText, Lock, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EditOptions, PdfAnnotation, PdfEdits, PdfPageRef } from "@/lib/formats";
import type { PdfFieldInfo } from "@/lib/conversion/pdf-edit";
import { FIELD_CLASS } from "./editor-parts";
import { PdfEditorRail } from "./pdf-editor-rail";
import { PageStage, PageThumb, type NewAnnotation, type PdfTool } from "./pdf-stage";

interface PdfEditorModalProps {
  file: File;
  targetFormat?: string;
  initialOptions?: EditOptions;
  onClose: () => void;
  onSave: (options: EditOptions, targetFormat?: string) => void;
}

/**
 * PDF editor. Everything the user does is recorded as a description of edits
 * (`EditOptions.pdf`); the file itself is only rewritten at conversion time.
 */
export function PdfEditorModal({ file, targetFormat = "", initialOptions, onClose, onSave }: PdfEditorModalProps) {
  const [options, setOptions] = useState<EditOptions>(initialOptions || {});
  const pdf = useMemo(() => options.pdf ?? {}, [options.pdf]);
  const patch = (next: Partial<EditOptions>) => setOptions((prev) => ({ ...prev, ...next }));
  const patchPdf = (next: Partial<PdfEdits>) => setOptions((prev) => ({ ...prev, pdf: { ...prev.pdf, ...next } }));

  const [docs, setDocs] = useState<PDFDocumentProxy[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "locked" | "error">("loading");
  const [message, setMessage] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [fields, setFields] = useState<PdfFieldInfo[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tool, setTool] = useState<PdfTool>("select");
  const [color, setColor] = useState("#e11d48");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { attachments, openPassword } = pdf;

  // Open the file and everything merged into it for previewing.
  useEffect(() => {
    let cancelled = false;
    const tasks: { destroy: () => unknown }[] = [];
    setStatus("loading");
    (async () => {
      try {
        const { openPdf } = await import("@/lib/conversion/documents");
        const loaded: PDFDocumentProxy[] = [];
        for (const [i, source] of [file, ...(attachments ?? [])].entries()) {
          const opened = await openPdf(source, i === 0 ? openPassword : undefined);
          tasks.push(opened.task);
          loaded.push(opened.doc);
        }
        if (cancelled) return;
        setDocs(loaded);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        const text = (err as Error)?.message || "This PDF could not be opened.";
        setMessage(text);
        setStatus(/password/i.test(text) ? "locked" : "error");
      }
    })();
    return () => {
      cancelled = true;
      tasks.forEach((task) => task.destroy());
    };
  }, [file, attachments, openPassword]);

  useEffect(() => {
    let cancelled = false;
    import("@/lib/conversion/pdf-edit")
      .then(({ listPdfFields }) => listPdfFields(file, openPassword))
      .then((found) => { if (!cancelled) setFields(found); })
      .catch(() => undefined); // locked or form-less: nothing to offer
    return () => { cancelled = true; };
  }, [file, openPassword]);

  const pages = useMemo<PdfPageRef[]>(
    () => pdf.pages ?? Array.from({ length: docs[0]?.numPages ?? 0 }, (_, index) => ({ key: `0:${index}`, source: 0, index, rotate: 0 })),
    [pdf.pages, docs]
  );
  const activeIndex = Math.max(0, pages.findIndex((page) => page.key === activeKey));
  const active = pages[activeIndex] as PdfPageRef | undefined;
  const annotations = useMemo(() => pdf.annotations ?? [], [pdf.annotations]);
  const selected = annotations.find((ann) => ann.id === selectedId);

  const mapAnnotations = (fn: (ann: PdfAnnotation) => PdfAnnotation | null) =>
    setOptions((prev) => ({
      ...prev,
      pdf: { ...prev.pdf, annotations: (prev.pdf?.annotations ?? []).map(fn).filter((ann): ann is PdfAnnotation => !!ann) },
    }));

  const addAnnotation = (draft: NewAnnotation) => {
    if (!active) return;
    const id = crypto.randomUUID();
    patchPdf({ annotations: [...annotations, { ...draft, id, page: active.key }] });
    setSelectedId(id);
    // Text is placed once and then edited; the drawing tools stay armed.
    if (draft.type === "text" || draft.type === "image") setTool("select");
  };

  const moveAnnotation = (id: string, dx: number, dy: number) =>
    mapAnnotations((ann) => ann.id !== id ? ann : {
      ...ann,
      x: ann.x + dx,
      y: ann.y + dy,
      strokes: ann.strokes?.map((points) => points.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
    });

  const deleteSelected = () => {
    if (!selectedId) return;
    mapAnnotations((ann) => (ann.id === selectedId ? null : ann));
    setSelectedId(null);
  };

  // Delete removes the selected item, unless the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" || !selectedId) return;
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      mapAnnotations((ann) => (ann.id === selectedId ? null : ann));
      setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const rotatePage = (by: number) =>
    active && patchPdf({ pages: pages.map((page) => page.key === active.key ? { ...page, rotate: (page.rotate + by + 360) % 360 } : page) });

  const movePage = (by: number) => {
    const to = activeIndex + by;
    if (!active || to < 0 || to >= pages.length) return;
    const next = [...pages];
    [next[activeIndex], next[to]] = [next[to], next[activeIndex]];
    patchPdf({ pages: next });
  };

  const deletePage = () => {
    if (!active || pages.length <= 1) return;
    const next = pages.filter((page) => page.key !== active.key);
    patchPdf({ pages: next, annotations: annotations.filter((ann) => ann.page !== active.key) });
    setActiveKey(next[Math.min(activeIndex, next.length - 1)].key);
  };

  const addFiles = async (files: File[]) => {
    try {
      const { wrapAsPdf } = await import("@/lib/conversion/pdf-edit");
      const { openPdf } = await import("@/lib/conversion/documents");
      const nextAttachments = [...(attachments ?? [])];
      const nextPages = [...pages];
      for (const picked of files) {
        const wrapped = await wrapAsPdf(picked);
        const { doc, task } = await openPdf(wrapped);
        const source = nextAttachments.push(wrapped);
        // The random part keeps keys unique if the same file is added twice.
        const batch = crypto.randomUUID().slice(0, 8);
        for (let index = 0; index < doc.numPages; index++) nextPages.push({ key: `${source}:${index}:${batch}`, source, index, rotate: 0 });
        await task.destroy();
      }
      patchPdf({ attachments: nextAttachments, pages: nextPages });
      setMessage("");
    } catch (err) {
      setMessage(`Could not add that file: ${(err as Error)?.message || "unreadable"}`);
    }
  };

  const addImage = async (picked: File) => {
    try {
      const bitmap = await createImageBitmap(picked);
      const width = 160;
      addAnnotation({ type: "image", image: picked, x: 40, y: 40, width, height: (bitmap.height / bitmap.width) * width });
      bitmap.close();
    } catch {
      setMessage("That picture could not be read.");
    }
  };

  const handleSave = () => {
    // An untouched target means "edit this PDF": keep it a PDF.
    onSave(options, targetFormat ? undefined : "PDF");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} className="absolute inset-0 bg-black/80 backdrop-blur-xl" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        data-omni="pdf-editor"
        className="relative w-full max-w-[1400px] h-[92vh] bg-[#1f2228] border border-white/10 rounded-[2.5rem] shadow-3xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between p-6 border-b border-white/5 bg-black/20">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-10 h-10 bg-[#e11d48]/10 rounded-xl flex items-center justify-center border border-[#e11d48]/20 shrink-0">
              <FileText className="w-5 h-5 text-[#e11d48]" />
            </div>
            <div className="min-w-0">
              <h3 className="text-xl font-black uppercase tracking-tight italic">PDF Editor</h3>
              <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest truncate">{file.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2.5 hover:bg-white/5 rounded-full transition-colors"><X className="w-6 h-6" /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-32 shrink-0 border-r border-white/5 overflow-y-auto p-3 space-y-2 bg-black/20">
            {status === "ready" && pages.map((page, i) => (
              <PageThumb
                key={page.key} doc={docs[page.source]} index={page.index} rotate={page.rotate} label={i + 1}
                active={i === activeIndex}
                onClick={() => { setActiveKey(page.key); setSelectedId(null); }}
              />
            ))}
          </div>

          <div className="flex-1 min-w-0 bg-[#0a0c10] overflow-auto p-8 flex flex-col items-center gap-4">
            {message && status === "ready" && <p className="text-[10px] font-black uppercase tracking-widest text-[#e11d48]">{message}</p>}
            {status === "loading" && <CircleDashed className="w-8 h-8 text-[#e11d48] animate-spin m-auto" />}
            {status === "error" && <p className="m-auto text-sm font-bold text-[#e11d48]">{message}</p>}
            {status === "locked" && (
              <form
                className="m-auto w-full max-w-sm space-y-4 text-center"
                onSubmit={(e) => { e.preventDefault(); patchPdf({ openPassword: passwordDraft }); }}
              >
                <Lock className="w-10 h-10 text-[#e11d48] mx-auto" />
                <p className="text-sm font-bold">{message}</p>
                <input
                  type="password" autoFocus aria-label="PDF password" placeholder="Password" className={FIELD_CLASS}
                  value={passwordDraft}
                  onChange={(e) => setPasswordDraft(e.target.value)}
                />
                <button className="w-full py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-2xl text-[10px] font-black uppercase tracking-widest">Unlock</button>
              </form>
            )}
            {status === "ready" && active && (
              <PageStage
                key={active.key}
                doc={docs[active.source]}
                index={active.index}
                rotate={active.rotate}
                annotations={annotations.filter((ann) => ann.page === active.key)}
                tool={tool}
                color={color}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onAdd={addAnnotation}
                onMove={moveAnnotation}
              />
            )}
          </div>

          <PdfEditorRail
            fileName={file.name}
            options={options}
            patch={patch}
            patchPdf={patchPdf}
            tool={tool}
            setTool={setTool}
            color={color}
            setColor={setColor}
            selected={selected}
            updateSelected={(next) => mapAnnotations((ann) => (ann.id === selectedId ? { ...ann, ...next } : ann))}
            deleteSelected={deleteSelected}
            pageNumber={activeIndex + 1}
            pageCount={pages.length}
            onRotatePage={rotatePage}
            onMovePage={movePage}
            onDeletePage={deletePage}
            onAddFiles={addFiles}
            onAddImage={addImage}
            fields={fields}
            onClose={onClose}
            onSave={handleSave}
          />
        </div>
      </motion.div>
    </div>
  );
}
