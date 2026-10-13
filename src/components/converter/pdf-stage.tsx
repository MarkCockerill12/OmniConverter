"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { cn } from "@/lib/utils";
import type { PdfAnnotation } from "@/lib/formats";

export type PdfTool = "select" | "text" | "highlight" | "rect" | "ink";
type Point = { x: number; y: number };
export type NewAnnotation = Omit<PdfAnnotation, "id" | "page">;

/** Renders one page into a canvas, scaled to fit `maxWidth` CSS pixels. */
function usePageRender(doc: PDFDocumentProxy | undefined, index: number, maxWidth: number) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, scale: 1 });

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | undefined;
    (async () => {
      try {
        const page = await doc.getPage(index + 1);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const scale = Math.min(2.5, maxWidth / page.getViewport({ scale: 1 }).width);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        setSize({ width: canvas.width, height: canvas.height, scale });
        task = page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport } as never);
        await task.promise;
      } catch {
        /* render cancelled, or the document was closed while a reload is under way */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, maxWidth]);

  return { canvasRef, size };
}

/** Keeps the layout box right when a page is shown turned on its side. */
function Turned({ width, height, rotate, children, className }: {
  width: number; height: number; rotate: number; children: React.ReactNode; className?: string;
}) {
  const sideways = rotate % 180 !== 0;
  return (
    <div className="relative shrink-0" style={{ width: sideways ? height : width, height: sideways ? width : height }}>
      <div
        className={cn("absolute left-1/2 top-1/2", className)}
        style={{ width, height, transform: `translate(-50%, -50%) rotate(${rotate}deg)` }}
      >
        {children}
      </div>
    </div>
  );
}

export function PageThumb({ doc, index, rotate, label, active, onClick }: {
  doc: PDFDocumentProxy | undefined; index: number; rotate: number; label: number; active: boolean; onClick: () => void;
}) {
  const { canvasRef, size } = usePageRender(doc, index, 84);
  return (
    <button
      onClick={onClick}
      data-omni="pdf-thumb"
      className={cn(
        "w-full flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-all",
        active ? "border-[#e11d48] bg-[#e11d48]/10" : "border-white/5 hover:border-white/20"
      )}
    >
      <Turned width={size.width} height={size.height} rotate={rotate} className="bg-white">
        <canvas ref={canvasRef} className="block" />
      </Turned>
      <span className="text-[9px] font-black text-neutral-400">{label}</span>
    </button>
  );
}

/** Hit box of an annotation in page points. */
export function annotationBounds(ann: Pick<PdfAnnotation, "type" | "x" | "y" | "width" | "height" | "text" | "size">) {
  if (ann.type !== "text") return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
  const size = ann.size ?? 14;
  const lines = (ann.text ?? "").split("\n");
  // Helvetica averages roughly half an em per character.
  return { x: ann.x, y: ann.y, width: Math.max(...lines.map((l) => l.length), 1) * size * 0.52, height: lines.length * size * 1.2 };
}

function AnnotationImage({ blob, style }: { blob: Blob; style: React.CSSProperties }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url ? <img src={url} alt="" className="absolute pointer-events-none" style={style} /> : null;
}

interface PageStageProps {
  doc: PDFDocumentProxy | undefined;
  index: number;
  rotate: number;
  /** Widest the page may be drawn, in CSS pixels. */
  maxWidth: number;
  annotations: PdfAnnotation[];
  tool: PdfTool;
  color: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (annotation: NewAnnotation) => void;
  onMove: (id: string, dx: number, dy: number) => void;
}

/** The working page: the rendered PDF with an interactive annotation layer on top. */
export function PageStage({ doc, index, rotate, maxWidth, annotations, tool, color, selectedId, onSelect, onAdd, onMove }: PageStageProps) {
  const { canvasRef, size } = usePageRender(doc, index, maxWidth);
  const { scale } = size;
  const drag = useRef<{ mode: "move" | "box" | "ink"; id?: string; last: Point } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [stroke, setStroke] = useState<Point[]>([]);

  // offsetX/Y are measured in the layer's own space, so they stay correct
  // when the page is shown rotated.
  const pointOf = (e: React.PointerEvent): Point => ({
    x: Math.max(0, Math.min(size.width, e.nativeEvent.offsetX)) / scale,
    y: Math.max(0, Math.min(size.height, e.nativeEvent.offsetY)) / scale,
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointOf(e);
    // Capture keeps a drag alive past the page edge; it is refused for
    // pointers that are no longer down, which is harmless.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (tool === "select") {
      const hit = [...annotations].reverse().find((ann) => {
        const b = annotationBounds(ann);
        return p.x >= b.x - 3 && p.x <= b.x + b.width + 3 && p.y >= b.y - 3 && p.y <= b.y + b.height + 3;
      });
      onSelect(hit?.id ?? null);
      drag.current = hit ? { mode: "move", id: hit.id, last: p } : null;
    } else if (tool === "text") {
      onAdd({ type: "text", x: p.x, y: p.y - 8, width: 0, height: 0, text: "Text", size: 14, color });
    } else if (tool === "ink") {
      drag.current = { mode: "ink", last: p };
      setStroke([p]);
    } else {
      drag.current = { mode: "box", last: p };
      setBox({ x: p.x, y: p.y, width: 0, height: 0 });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const p = pointOf(e);
    if (state.mode === "move" && state.id) {
      onMove(state.id, p.x - state.last.x, p.y - state.last.y);
      state.last = p;
    } else if (state.mode === "ink") {
      setStroke((prev) => [...prev, p]);
    } else {
      const origin = state.last;
      setBox({ x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y), width: Math.abs(p.x - origin.x), height: Math.abs(p.y - origin.y) });
    }
  };

  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (state?.mode === "box" && box && box.width > 3 && box.height > 3) {
      onAdd({ type: tool === "highlight" ? "highlight" : "rect", ...box, color });
    }
    if (state?.mode === "ink" && stroke.length > 1) {
      const xs = stroke.map((p) => p.x);
      const ys = stroke.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      onAdd({ type: "ink", x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, strokes: [stroke], strokeWidth: 2, color });
    }
    setBox(null);
    setStroke([]);
  };

  const px = (b: { x: number; y: number; width: number; height: number }) => ({
    left: b.x * scale, top: b.y * scale, width: b.width * scale, height: b.height * scale,
  });
  const selected = annotations.find((ann) => ann.id === selectedId);
  const inks = annotations.filter((ann) => ann.type === "ink");

  return (
    <Turned width={size.width} height={size.height} rotate={rotate} className="bg-white shadow-2xl">
      <canvas ref={canvasRef} className="block" />
      <div
        data-omni="pdf-layer"
        className={cn("absolute inset-0 touch-none select-none", tool === "select" ? "cursor-default" : "cursor-crosshair")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {annotations.map((ann) => {
          if (ann.type === "text") {
            return (
              <div
                key={ann.id}
                className="absolute pointer-events-none whitespace-pre"
                style={{
                  left: ann.x * scale, top: ann.y * scale, color: ann.color, opacity: ann.opacity ?? 1,
                  fontSize: (ann.size ?? 14) * scale, lineHeight: 1.2, fontFamily: "Helvetica, Arial, sans-serif",
                }}
              >
                {ann.text}
              </div>
            );
          }
          if (ann.type === "image" && ann.image) return <AnnotationImage key={ann.id} blob={ann.image} style={{ ...px(ann), opacity: ann.opacity ?? 1 }} />;
          if (ann.type === "highlight" || ann.type === "rect") {
            return (
              <div
                key={ann.id}
                className="absolute pointer-events-none"
                style={{
                  ...px(ann), background: ann.color,
                  opacity: ann.opacity ?? (ann.type === "highlight" ? 0.4 : 1),
                  mixBlendMode: ann.type === "highlight" ? "multiply" : undefined,
                }}
              />
            );
          }
          return null;
        })}

        <svg className="absolute inset-0 pointer-events-none" width={size.width} height={size.height}>
          {inks.flatMap((ann) => (ann.strokes ?? []).map((points, i) => (
            <polyline
              key={`${ann.id}-${i}`} fill="none" strokeLinecap="round" strokeLinejoin="round"
              stroke={ann.color} strokeWidth={(ann.strokeWidth ?? 2) * scale} opacity={ann.opacity ?? 1}
              points={points.map((p) => `${p.x * scale},${p.y * scale}`).join(" ")}
            />
          )))}
          {stroke.length > 1 && (
            <polyline fill="none" strokeLinecap="round" stroke={color} strokeWidth={2 * scale} points={stroke.map((p) => `${p.x * scale},${p.y * scale}`).join(" ")} />
          )}
        </svg>

        {box && <div className="absolute pointer-events-none border border-dashed border-[#e11d48] bg-[#e11d48]/10" style={px(box)} />}
        {selected && (
          <div className="absolute pointer-events-none outline-dashed outline-1 outline-offset-2 outline-[#e11d48]" style={px(annotationBounds(selected))} />
        )}
      </div>
    </Turned>
  );
}
