"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  ArrowRight, Box, CheckCircle2, CircleDashed, Download, Eye, EyeOff, Settings2,
  Grid3x3, Focus, Layers2, Sparkles, Settings, Sun,
} from "lucide-react";
import { cn, is3DFile } from "@/lib/utils";
import type { SceneNode, ThreeDViewerHandle } from "@/components/ui/three-viewer";
import type { DisplayMode, SceneStats } from "@/lib/3d-materials";
import type { Projection } from "@/hooks/use-three-scene";
import type { SelectedFile } from "@/components/converter/file-queue";
import { AnimationBar, StatsBar, type AnimationClipInfo } from "@/components/converter/forge-hud";
import { loadSetting, saveSetting } from "@/lib/storage";

const ThreeDViewer = dynamic(() => import("@/components/ui/three-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col items-center justify-center h-full">
      <CircleDashed className="w-10 h-10 text-[#e11d48] animate-spin mb-4" />
      <p className="text-neutral-500 font-bold tracking-widest uppercase text-xs">Waking up WebGL...</p>
    </div>
  )
});

const VIEWPORT_THEMES = [
  { name: "Light", color: "#d1d5db" },
  { name: "Dark Grey", color: "#1f2228" },
  { name: "Dark Blue", color: "#0f172a" },
  { name: "Black", color: "#000000" }
];

const DISPLAY_MODES: { id: DisplayMode; label: string }[] = [
  { id: "shaded", label: "Shaded" },
  { id: "wireframe", label: "Wire" },
  { id: "normals", label: "Normals" },
  { id: "uv", label: "UV" },
];

const TEXTURE_CAPS = [
  { value: 0, label: "Original" },
  { value: 2048, label: "2048" },
  { value: 1024, label: "1024" },
  { value: 512, label: "512" },
];

interface ForgePanelProps {
  files: SelectedFile[];
  selected3DId: string | null;
  onSelect3D: (id: string | null) => void;
}

export function ForgePanel({ files, selected3DId, onSelect3D }: ForgePanelProps) {
  const [sceneNodes, setSceneNodes] = useState<SceneNode[]>([]);
  const [hiddenNodes, setHiddenNodes] = useState<string[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [viewportTheme, setViewportTheme] = useState(VIEWPORT_THEMES[0]);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("shaded");
  const [unlit, setUnlit] = useState(false);
  const [unlitTouched, setUnlitTouched] = useState(false);
  const [projection, setProjection] = useState<Projection>("perspective");
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [clips, setClips] = useState<AnimationClipInfo[]>([]);
  const [activeClip, setActiveClip] = useState<string | null>(null);
  const [animationTime, setAnimationTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [compressExport, setCompressExport] = useState(false);
  const [maxTextureSize, setMaxTextureSize] = useState(0);
  const viewerRef = useRef<ThreeDViewerHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const modelFiles = useMemo(() => files.filter(sf => is3DFile(sf.file.name)), [files]);
  // Keyed on identity, not on array reference: conversion progress updates must
  // not retrigger archive discovery in the viewer.
  const signature = modelFiles.map(sf => `${sf.file.name}:${sf.file.size}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const active3DFiles = useMemo(() => modelFiles.map(sf => sf.file), [signature]);

  // Viewport preferences survive reloads.
  useEffect(() => {
    (async () => {
      const saved = await loadSetting<{ theme?: string; displayMode?: DisplayMode; projection?: Projection; sidebarWidth?: number; unlit?: boolean }>("forge");
      if (!saved) return;
      const theme = VIEWPORT_THEMES.find(t => t.name === saved.theme);
      if (theme) setViewportTheme(theme);
      if (saved.displayMode) setDisplayMode(saved.displayMode);
      if (typeof saved.unlit === "boolean") { setUnlit(saved.unlit); setUnlitTouched(true); }
      if (saved.projection) setProjection(saved.projection);
      if (saved.sidebarWidth) setSidebarWidth(saved.sidebarWidth);
    })();
  }, []);

  useEffect(() => {
    // Only an explicit choice is remembered; otherwise each session re-detects
    // whether the loaded model wants unlit shading.
    saveSetting("forge", {
      theme: viewportTheme.name,
      displayMode,
      projection,
      sidebarWidth,
      ...(unlitTouched ? { unlit } : {}),
    });
  }, [viewportTheme, displayMode, projection, sidebarWidth, unlit, unlitTouched]);

  const startResizing = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      const newWidth = ev.clientX - container.getBoundingClientRect().left;
      if (newWidth > 150 && newWidth < 600) container.style.setProperty('--sidebar-width', `${newWidth}px`);
    };
    const onUp = () => {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (sidebarRef.current) setSidebarWidth(sidebarRef.current.offsetWidth);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  useEffect(() => () => {
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  const toggleNodeVisibility = (nodeId: string) => {
    setHiddenNodes(prev => prev.includes(nodeId) ? prev.filter(id => id !== nodeId) : [...prev, nodeId]);
  };

  const renderNodeTree = (nodes: SceneNode[], depth = 0): React.ReactNode => nodes.map((node) => (
    <div key={node.id} className="py-0.5 w-full">
      <div
        style={{ paddingLeft: `${depth * 8}px` }}
        className="flex items-center justify-between group px-2 hover:bg-white/5 rounded transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 py-1.5 flex-1">
          <div className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            node.type === 'Mesh' ? "bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.5)]" : "bg-neutral-600"
          )} />
          <span className="text-[12px] font-bold text-neutral-200 truncate tracking-tight">{node.name}</span>
        </div>
        <button
          onClick={() => toggleNodeVisibility(node.id)}
          className="p-1.5 text-neutral-500 hover:text-white transition-colors shrink-0"
        >
          {hiddenNodes.includes(node.id) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      {node.children.length > 0 && renderNodeTree(node.children, depth + 1)}
    </div>
  ));

  const exportModel = () => {
    const preferredFormat = modelFiles.find(sf => sf.targetFormat)?.targetFormat || 'glb';
    viewerRef.current?.exportGLB(preferredFormat, undefined, {
      compress: compressExport,
      maxTextureSize: maxTextureSize || undefined,
    });
  };

  return (
    <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="mt-24 mb-12">
      <div
        ref={containerRef}
        className="forge-container bg-[#1f2228] border border-white/10 rounded-[2.5rem] p-4 lg:p-6 shadow-3xl overflow-hidden"
        style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      >
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-6 px-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-900/30 ring-4 ring-purple-600/10 shrink-0">
              <Box className="w-7 h-7 text-white" />
            </div>
            <div className="space-y-2">
              <h2 className="text-3xl font-black italic tracking-tighter uppercase leading-none text-white">3D Forge Viewport</h2>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-3 bg-neutral-900/80 px-4 py-2 rounded-xl border border-white/10 w-fit backdrop-blur-md shadow-2xl">
                  <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest mr-2">Atmosphere:</p>
                  {VIEWPORT_THEMES.map((theme) => (
                    <button
                      key={theme.name}
                      onClick={() => setViewportTheme(theme)}
                      className={cn(
                        "w-6 h-6 rounded-md border-2 transition-all relative group/theme",
                        viewportTheme.name === theme.name ? "border-emerald-500 scale-110 shadow-[0_0_15px_rgba(16,185,129,0.3)]" : "border-white/20 hover:border-white/50"
                      )}
                      style={{ backgroundColor: theme.color }}
                      title={theme.name}
                    >
                      {viewportTheme.name === theme.name && <CheckCircle2 className="w-3 h-3 text-white absolute -top-1.5 -right-1.5 bg-emerald-500 rounded-full shadow-lg" />}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1 bg-neutral-900/80 px-2 py-2 rounded-xl border border-white/10 w-fit backdrop-blur-md shadow-2xl">
                  {DISPLAY_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      onClick={() => setDisplayMode(mode.id)}
                      title={`${mode.label} view`}
                      className={cn(
                        "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all",
                        displayMode === mode.id ? "bg-purple-600 text-white shadow-lg shadow-purple-900/40" : "text-neutral-500 hover:text-white hover:bg-white/5"
                      )}
                    >
                      {mode.label}
                    </button>
                  ))}
                  <div className="w-px h-5 bg-white/10 mx-1" />
                  <button
                    onClick={() => setProjection(projection === "perspective" ? "orthographic" : "perspective")}
                    title={projection === "perspective" ? "Switch to orthographic" : "Switch to perspective"}
                    className={cn(
                      "p-1.5 rounded-lg transition-all",
                      projection === "orthographic" ? "bg-purple-600 text-white" : "text-neutral-500 hover:text-white hover:bg-white/5"
                    )}
                  >
                    <Grid3x3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setUnlit(u => !u); setUnlitTouched(true); }}
                    title={unlit ? "Use scene lighting" : "Unlit (show baked texture colours)"}
                    className={cn(
                      "p-1.5 rounded-lg transition-all",
                      unlit ? "bg-purple-600 text-white" : "text-neutral-500 hover:text-white hover:bg-white/5"
                    )}
                  >
                    <Sun className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => viewerRef.current?.frameCamera()}
                    title="Frame all models"
                    className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/5 transition-all"
                  >
                    <Focus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          {active3DFiles.length > 0 && (
            <div className="relative shrink-0 flex items-center gap-2">
              <button
                onClick={() => setIsExportOpen(!isExportOpen)}
                title="Export options"
                className={cn(
                  "p-3 rounded-xl border transition-all shadow-lg",
                  isExportOpen ? "bg-emerald-600 border-emerald-600 text-white" : "bg-white/5 border-white/10 text-neutral-400 hover:text-white"
                )}
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                onClick={exportModel}
                className="flex items-center gap-3 px-8 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-sm font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-900/40 active:scale-95 group"
              >
                <Download className="w-4 h-4 group-hover:animate-bounce" /> Export Master Model
              </button>

              {isExportOpen && (
                <div className="absolute top-full right-0 mt-3 w-72 bg-[#1f2228]/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl p-5 z-50 space-y-5">
                  <div className="flex items-center gap-2 text-emerald-500">
                    <Sparkles className="w-3.5 h-3.5" />
                    <p className="text-[10px] font-black uppercase tracking-widest">Export Optimisation</p>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-emerald-500"
                      checked={compressExport}
                      onChange={(e) => setCompressExport(e.target.checked)}
                    />
                    <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400 group-hover:text-white transition-colors">
                      Compress geometry (Meshopt)
                    </span>
                  </label>
                  <div className="space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500 flex items-center gap-2">
                      <Layers2 className="w-3 h-3" /> Max texture size
                    </p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {TEXTURE_CAPS.map((cap) => (
                        <button
                          key={cap.value}
                          onClick={() => setMaxTextureSize(cap.value)}
                          className={cn(
                            "py-2 rounded-lg text-[9px] font-black uppercase tracking-widest border transition-all",
                            maxTextureSize === cap.value
                              ? "bg-emerald-600 border-emerald-600 text-white"
                              : "bg-black/40 border-white/10 text-neutral-500 hover:border-white/20"
                          )}
                        >
                          {cap.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[9px] text-neutral-500 font-medium italic">
                    Applies to GLB exports. Meshopt-compressed files reopen here and in any glTF viewer that supports EXT_meshopt_compression.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex bg-black/40 rounded-[1.5rem] border border-white/5 overflow-hidden h-[550px] relative">
          {/* Node Tree Sidebar - Using CSS Variable for zero-lag resize */}
          <motion.div
            ref={sidebarRef}
            initial={false}
            animate={{ width: isSidebarOpen ? 'var(--sidebar-width)' : 0, opacity: isSidebarOpen ? 1 : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 40 }}
            className="bg-[#1a1d23] border-r border-white/10 flex flex-col z-20 overflow-hidden shrink-0 relative"
            style={{ width: 'var(--sidebar-width)' }}
          >
            <div className="flex items-center justify-between p-4 bg-white/2 border-b border-white/5 shrink-0 whitespace-nowrap">
              <div className="flex items-center gap-2">
                <Settings2 className="w-3.5 h-3.5 text-purple-400" />
                <h3 className="text-[11px] font-black uppercase tracking-[0.15em] text-neutral-200">Node Inspector</h3>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3" style={{ width: 'var(--sidebar-width)' }}>
              {sceneNodes.length > 0 ? renderNodeTree(sceneNodes) : (
                <div className="flex flex-col items-center justify-center h-full opacity-30">
                  <CircleDashed className="w-8 h-8 animate-spin mb-4 text-purple-500" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-center text-white">Reading Mesh...</p>
                </div>
              )}
            </div>
            {isSidebarOpen && <div onPointerDown={startResizing} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-purple-500/50 transition-colors z-30 active:bg-purple-500" />}
          </motion.div>

          {/* Viewport - Flex-1 ensures it always fills space */}
          <div className="flex-1 min-w-0 relative bg-neutral-200 overflow-hidden">
            {active3DFiles.length > 0 ? (
              <ThreeDViewer
                ref={viewerRef}
                files={active3DFiles}
                onNodesLoaded={setSceneNodes}
                onStats={setStats}
                onAnimations={(list) => { setClips(list); setActiveClip(list[0]?.name ?? null); }}
                onAnimationTime={setAnimationTime}
                onConsoleModel={(isConsole) => { if (isConsole && !unlitTouched) setUnlit(true); }}
                hiddenNodes={hiddenNodes}
                backgroundColor={viewportTheme.color}
                displayMode={displayMode}
                unlit={unlit}
                projection={projection}
                activeClip={activeClip}
                isPlaying={isPlaying}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full bg-[#16191d]">
                <Box className="w-32 h-32 text-white/5 animate-pulse" />
                <p className="text-neutral-500 font-bold tracking-widest uppercase text-xs mt-4">Awaiting 3D Input</p>
              </div>
            )}

            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="absolute top-4 left-4 z-40 bg-[#1f2228]/95 backdrop-blur-xl border border-white/10 p-3 rounded-xl text-neutral-400 hover:text-white transition-all shadow-2xl pointer-events-auto active:scale-95">
              <motion.div animate={{ rotate: isSidebarOpen ? 180 : 0 }}><ArrowRight className="w-4 h-4" /></motion.div>
            </button>

            {/* Model Catalog Selection Bar */}
            <div className="absolute top-4 left-20 right-4 z-40 flex items-center gap-2 overflow-x-auto no-scrollbar pointer-events-none">
              {modelFiles.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelect3D(selected3DId === m.id ? null : m.id)}
                  className={cn(
                    "px-4 py-2 rounded-xl border backdrop-blur-md transition-all pointer-events-auto shrink-0 flex items-center gap-2",
                    selected3DId === m.id
                      ? "bg-[#e11d48] border-[#e11d48] text-white shadow-lg shadow-[#e11d48]/20"
                      : "bg-[#1f2228]/80 border-white/10 text-neutral-400 hover:bg-[#1f2228] hover:text-white"
                  )}
                >
                  <Box className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-black uppercase tracking-widest truncate max-w-[120px]">{m.file.name}</span>
                </button>
              ))}
            </div>

            <AnimationBar
              clips={clips}
              activeClip={activeClip}
              time={animationTime}
              isPlaying={isPlaying}
              onSelect={setActiveClip}
              onToggle={() => setIsPlaying(p => !p)}
              onSeek={(time) => { setAnimationTime(time); viewerRef.current?.seekAnimation(time); }}
            />

            <StatsBar
              fileCount={active3DFiles.length}
              nodeCount={sceneNodes[0]?.count || 0}
              stats={stats}
              environment={viewportTheme.name}
            />
          </div>
        </div>
      </div>
    </motion.section>
  );
}
