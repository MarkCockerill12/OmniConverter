"use client";

import { useRef } from "react";
import {
  ArrowDown, ArrowUp, Check, FilePlus2, Highlighter, ImagePlus, Info, Layers, ListChecks, Lock, MousePointer2,
  PenLine, RotateCcw, RotateCw, Square, Stamp, Trash2, Type,
} from "lucide-react";
import type { EditOptions, PdfAnnotation, PdfEdits } from "@/lib/formats";
import type { PdfFieldInfo } from "@/lib/conversion/pdf-edit";
import { CompressionSection } from "./editor-adjustments";
import { EditorSection, FIELD_CLASS, GhostButton, HINT_CLASS, LABEL_CLASS, Slider, Toggle } from "./editor-parts";
import type { PdfTool } from "./pdf-stage";

const TOOLS: { id: PdfTool; label: string; icon: React.ReactNode }[] = [
  { id: "select", label: "Select", icon: <MousePointer2 className="w-4 h-4" /> },
  { id: "text", label: "Text", icon: <Type className="w-4 h-4" /> },
  { id: "highlight", label: "Highlight", icon: <Highlighter className="w-4 h-4" /> },
  { id: "rect", label: "Cover", icon: <Square className="w-4 h-4" /> },
  { id: "ink", label: "Draw", icon: <PenLine className="w-4 h-4" /> },
];

interface PdfEditorRailProps {
  fileName: string;
  options: EditOptions;
  patch: (next: Partial<EditOptions>) => void;
  patchPdf: (next: Partial<PdfEdits>) => void;
  tool: PdfTool;
  setTool: (tool: PdfTool) => void;
  color: string;
  setColor: (color: string) => void;
  selected: PdfAnnotation | undefined;
  updateSelected: (next: Partial<PdfAnnotation>) => void;
  deleteSelected: () => void;
  pageNumber: number;
  pageCount: number;
  onRotatePage: (by: number) => void;
  onMovePage: (by: number) => void;
  onDeletePage: () => void;
  onAddFiles: (files: File[]) => void;
  onAddImage: (file: File) => void;
  fields: PdfFieldInfo[];
  onClose: () => void;
  onSave: () => void;
}

/** Right-hand rail of the PDF editor: tools, page operations and document settings. */
export function PdfEditorRail({
  fileName, options, patch, patchPdf, tool, setTool, color, setColor, selected, updateSelected, deleteSelected,
  pageNumber, pageCount, onRotatePage, onMovePage, onDeletePage, onAddFiles, onAddImage, fields, onClose, onSave,
}: PdfEditorRailProps) {
  const mergeInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const pdf = options.pdf ?? {};
  const meta = pdf.metadata ?? {};
  const mark = pdf.watermark;
  const setMeta = (key: keyof NonNullable<PdfEdits["metadata"]>, value: string) => patchPdf({ metadata: { ...meta, [key]: value } });
  const setMark = (next: Partial<NonNullable<PdfEdits["watermark"]>>) =>
    patchPdf({ watermark: { text: "", opacity: 0.2, size: 64, color: "#e11d48", ...mark, ...next } });

  return (
    <div className="border-l border-white/5 p-6 xl:p-8 space-y-10 w-[320px] xl:w-[400px] shrink-0 bg-[#1a1d23] overflow-y-auto">
      <EditorSection title="Tools" icon={<PenLine className="w-4 h-4" />}>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {TOOLS.map((t) => (
              <GhostButton key={t.id} stacked active={tool === t.id} onClick={() => setTool(t.id)}>{t.icon} {t.label}</GhostButton>
            ))}
            <GhostButton stacked onClick={() => imageInput.current?.click()} title="Place a picture or a scanned signature">
              <ImagePlus className="w-4 h-4" /> Image
            </GhostButton>
          </div>
          <input
            ref={imageInput} type="file" accept="image/*" className="hidden" data-omni="pdf-image-input"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onAddImage(f); e.target.value = ""; }}
          />
          <div className="flex items-center gap-3">
            <input type="color" aria-label="Colour" className="w-10 h-10 shrink-0 rounded-lg bg-transparent cursor-pointer" value={color} onChange={(e) => setColor(e.target.value)} />
            <p className={HINT_CLASS}>
              {tool === "rect" ? "Cover hides what is under it but does not delete the hidden text from the file."
                : tool === "text" ? "Click the page to place text, then edit it below."
                : tool === "select" ? "Click an item to select it; drag to move, Delete to remove."
                : "Drag on the page."}
            </p>
          </div>

          {selected && (
            <div className="p-4 bg-black/40 rounded-2xl border border-white/5 space-y-4" data-omni="pdf-selection">
              {selected.type === "text" && (
                <>
                  <textarea
                    aria-label="Text" rows={3} className={FIELD_CLASS}
                    value={selected.text ?? ""}
                    onChange={(e) => updateSelected({ text: e.target.value })}
                  />
                  <Slider label="Size" min={6} max={96} suffix="pt" value={selected.size ?? 14} onChange={(size) => updateSelected({ size })} />
                </>
              )}
              {selected.type === "image" && (
                <Slider
                  label="Width" min={20} max={600} suffix="pt" value={Math.round(selected.width)}
                  onChange={(width) => updateSelected({ width, height: (selected.height / selected.width) * width })}
                />
              )}
              {selected.type === "ink" && (
                <Slider label="Stroke" min={1} max={12} step={0.5} suffix="pt" value={selected.strokeWidth ?? 2} onChange={(strokeWidth) => updateSelected({ strokeWidth })} />
              )}
              {selected.type !== "image" && (
                <div className="flex items-center gap-3">
                  <input type="color" aria-label="Item colour" className="w-10 h-10 shrink-0 rounded-lg bg-transparent cursor-pointer" value={selected.color ?? "#000000"} onChange={(e) => updateSelected({ color: e.target.value })} />
                  <span className={LABEL_CLASS}>Item colour</span>
                </div>
              )}
              <Slider
                label="Opacity" min={5} max={100} step={5} suffix="%"
                value={Math.round((selected.opacity ?? (selected.type === "highlight" ? 0.4 : 1)) * 100)}
                onChange={(v) => updateSelected({ opacity: v / 100 })}
              />
              <GhostButton onClick={deleteSelected}><Trash2 className="w-4 h-4" /> Delete item</GhostButton>
            </div>
          )}
        </div>
      </EditorSection>

      <EditorSection title={`Page ${pageNumber} of ${pageCount}`} icon={<Layers className="w-4 h-4" />}>
        <div className="space-y-3">
          <div className="grid grid-cols-5 gap-2">
            <GhostButton title="Rotate page left" onClick={() => onRotatePage(-90)}><RotateCcw className="w-4 h-4" /></GhostButton>
            <GhostButton title="Rotate page right" onClick={() => onRotatePage(90)}><RotateCw className="w-4 h-4" /></GhostButton>
            <GhostButton title="Move page earlier" disabled={pageNumber <= 1} onClick={() => onMovePage(-1)}><ArrowUp className="w-4 h-4" /></GhostButton>
            <GhostButton title="Move page later" disabled={pageNumber >= pageCount} onClick={() => onMovePage(1)}><ArrowDown className="w-4 h-4" /></GhostButton>
            <GhostButton title="Delete page" disabled={pageCount <= 1} onClick={onDeletePage}><Trash2 className="w-4 h-4" /></GhostButton>
          </div>
          <input
            ref={mergeInput} type="file" multiple accept="application/pdf,image/*" className="hidden" data-omni="pdf-merge-input"
            onChange={(e) => { if (e.target.files?.length) onAddFiles(Array.from(e.target.files)); e.target.value = ""; }}
          />
          <GhostButton onClick={() => mergeInput.current?.click()}><FilePlus2 className="w-4 h-4" /> Add pages from PDF or image</GhostButton>
          <Toggle label="Split into one PDF per page" checked={!!pdf.split} onChange={(on) => patchPdf({ split: on || undefined })} />
          <p className={HINT_CLASS}>Reordering or merging rebuilds the file: fillable fields and bookmarks are not carried over.</p>
        </div>
      </EditorSection>

      {fields.length > 0 && (
        <EditorSection title="Form Fields" icon={<ListChecks className="w-4 h-4" />}>
          <div className="space-y-3">
            {fields.map((field) => {
              const value = pdf.fields?.[field.name] ?? field.value;
              const set = (next: string | boolean) => patchPdf({ fields: { ...pdf.fields, [field.name]: next } });
              if (field.kind === "checkbox") return <Toggle key={field.name} label={field.name} checked={!!value} onChange={set} />;
              return (
                <div key={field.name} className="space-y-1.5 min-w-0">
                  <label className={LABEL_CLASS}>{field.name}</label>
                  {field.kind === "choice" ? (
                    <select aria-label={field.name} className={FIELD_CLASS} value={String(value)} onChange={(e) => set(e.target.value)}>
                      <option value="">-</option>
                      {field.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                    </select>
                  ) : (
                    <input aria-label={field.name} className={FIELD_CLASS} value={String(value)} onChange={(e) => set(e.target.value)} />
                  )}
                </div>
              );
            })}
            <Toggle label="Flatten (make answers permanent)" checked={!!pdf.flattenForm} onChange={(on) => patchPdf({ flattenForm: on || undefined })} />
          </div>
        </EditorSection>
      )}

      <EditorSection title="Stamps" icon={<Stamp className="w-4 h-4" />}>
        <div className="space-y-4">
          <input
            aria-label="Watermark text" placeholder="Watermark text (e.g. DRAFT)" className={FIELD_CLASS}
            value={mark?.text ?? ""}
            onChange={(e) => (e.target.value ? setMark({ text: e.target.value }) : patchPdf({ watermark: undefined }))}
          />
          {mark?.text && (
            <>
              <Slider label="Watermark size" min={12} max={160} suffix="pt" value={mark.size} onChange={(size) => setMark({ size })} />
              <Slider label="Watermark opacity" min={5} max={100} step={5} suffix="%" value={Math.round(mark.opacity * 100)} onChange={(v) => setMark({ opacity: v / 100 })} />
            </>
          )}
          <Toggle label="Number the pages" checked={!!pdf.pageNumbers} onChange={(on) => patchPdf({ pageNumbers: on || undefined })} />
        </div>
      </EditorSection>

      <EditorSection title="Properties" icon={<Info className="w-4 h-4" />}>
        <div className="space-y-3">
          {(["title", "author", "subject", "keywords"] as const).map((key) => (
            <input
              key={key} aria-label={key} placeholder={key === "keywords" ? "Keywords, comma separated" : key[0].toUpperCase() + key.slice(1)}
              className={FIELD_CLASS} disabled={!!pdf.stripMetadata}
              value={meta[key] ?? ""}
              onChange={(e) => setMeta(key, e.target.value)}
            />
          ))}
          <Toggle label="Strip all metadata" checked={!!pdf.stripMetadata} onChange={(on) => patchPdf({ stripMetadata: on || undefined })} />
        </div>
      </EditorSection>

      <EditorSection title="Security" icon={<Lock className="w-4 h-4" />}>
        <div className="space-y-3">
          <input
            type="password" autoComplete="new-password" aria-label="Protect with password" placeholder="Password to open (optional)"
            className={FIELD_CLASS}
            value={pdf.protectPassword ?? ""}
            onChange={(e) => patchPdf({ protectPassword: e.target.value || undefined })}
          />
          <p className={HINT_CLASS}>AES-256. Applies when the output is a PDF; there is no way to recover a lost password.</p>
        </div>
      </EditorSection>

      <CompressionSection options={options} patch={patch} fileName={fileName} targetFormat="PDF" />

      <div className="pt-8 border-t border-white/5 flex gap-3">
        <button onClick={onClose} className="flex-1 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-colors">Discard</button>
        <button onClick={onSave} className="flex-[1.5] py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl shadow-[#e11d48]/20 flex items-center justify-center gap-2 group">
          Save <Check className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
