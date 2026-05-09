"use client";

import { useState, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { useWorkers } from "@/hooks/use-workers";
import { useStore } from "@/lib/store";
import { 
  FileVideo, 
  Box, 
  Upload, 
  X, 
  Zap, 
  ArrowRight, 
  Search, 
  Settings2,
  FileBox,
  Layout,
  CircleDashed,
  CheckCircle2,
  Plus,
  ChevronDown,
  AlertCircle,
  Eye,
  EyeOff,
  Download,
  Trash2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FormatDropdown, StatusBadge, FORMAT_CATEGORIES, getFileCategory } from "@/components/converter/format-selector";
import type { SceneNode, ThreeDViewerHandle } from "@/components/ui/three-viewer";

const ThreeDViewer = dynamic(() => import("@/components/ui/three-viewer"), { 
  ssr: false,
  loading: () => (
    <div className="flex flex-col items-center justify-center h-full">
      <CircleDashed className="w-10 h-10 text-[#e11d48] animate-spin mb-4" />
      <p className="text-neutral-500 font-bold tracking-widest uppercase text-xs">Waking up WebGL...</p>
    </div>
  )
});

interface SelectedFile {
  file: File;
  targetFormat: string;
  id: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
}

const VIEWPORT_THEMES = [
  { name: "Light", color: "#d1d5db" },
  { name: "Dark Grey", color: "#1f2228" },
  { name: "Dark Blue", color: "#0f172a" },
  { name: "Black", color: "#000000" }
];

export default function Home() {
  const { mediaWorker } = useWorkers();
  const { isMediaReady, isScraperReady } = useStore();
  
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 3D Management State
  const [sceneNodes, setSceneNodes] = useState<SceneNode[]>([]);
  const [hiddenNodes, setHiddenNodes] = useState<string[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [isResizing, setIsResizing] = useState(false);
  const [viewportTheme, setViewportTheme] = useState(VIEWPORT_THEMES[0]);
  const viewerRef = useRef<ThreeDViewerHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const startResizing = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const stopResizing = () => {
    if (!isResizing) return;
    setIsResizing(false);
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
    if (sidebarRef.current) {
      setSidebarWidth(sidebarRef.current.offsetWidth);
    }
  };

  const resize = (e: React.PointerEvent) => {
    if (!isResizing || !sidebarRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newWidth = e.clientX - rect.left;
    if (newWidth > 150 && newWidth < 600) {
      // CSS Variable update: The most performant way to resize without React lag
      containerRef.current.style.setProperty('--sidebar-width', `${newWidth}px`);
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const newFiles = Array.from(files).map(f => ({
      file: f,
      targetFormat: "",
      id: Math.random().toString(36).substring(2, 11),
      status: 'idle' as const,
      progress: 0
    }));
    setSelectedFiles(prev => [...prev, ...newFiles]);
  };

  const removeFile = (id: string) => {
    setSelectedFiles(prev => prev.filter(f => f.id !== id));
  };

  const updateFormat = (id: string, format: string) => {
    setSelectedFiles(prev => prev.map(f => f.id === id ? { ...f, targetFormat: format } : f));
  };

  const toggleNodeVisibility = (nodeId: string) => {
    setHiddenNodes(prev => 
      prev.includes(nodeId) ? prev.filter(id => id !== nodeId) : [...prev, nodeId]
    );
  };

  const handleConvertAll = async () => {
    if (!mediaWorker || selectedFiles.length === 0) return;
    setIsConverting(true);

    const filesToConvert = selectedFiles.filter(f => f.targetFormat && f.status !== 'completed');

    for (const sf of filesToConvert) {
      const category = getFileCategory(sf.file.name);
      if (category === "3D Model" || category === "Document" || category === "Archive") {
        setSelectedFiles(prev => prev.map(f => f.id === sf.id ? { 
          ...f, 
          status: 'error', 
          error: `${category} conversion not yet implemented.` 
        } : f));
        continue;
      }

      setSelectedFiles(prev => prev.map(f => f.id === sf.id ? { ...f, status: 'processing', error: undefined, progress: 0 } : f));

      await new Promise((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data.fileId !== sf.id) return;
          if (e.data.type === 'CONVERSION_PROGRESS') {
             setSelectedFiles(prev => prev.map(f => f.id === sf.id ? { ...f, progress: e.data.progress } : f));
          }
          if (e.data.type === 'CONVERSION_ERROR') {
            setSelectedFiles(prev => prev.map(f => f.id === sf.id ? { ...f, status: 'error', error: e.data.error || "Conversion failed" } : f));
            mediaWorker.removeEventListener('message', handler);
            resolve(false);
          }
          if (e.data.type === 'CONVERSION_SUCCESS') {
            setSelectedFiles(prev => prev.map(f => f.id === sf.id ? { ...f, status: 'completed', progress: 100 } : f));
            const url = URL.createObjectURL(e.data.output);
            const a = document.createElement('a');
            a.href = url;
            a.download = e.data.fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            mediaWorker.removeEventListener('message', handler);
            resolve(true);
          }
        };
        mediaWorker.addEventListener('message', handler);
        mediaWorker.postMessage({ type: 'TRANSCODE', payload: { file: sf.file, targetFormat: sf.targetFormat, fileId: sf.id } });
        setTimeout(() => { mediaWorker.removeEventListener('message', handler); resolve(false); }, 300000); 
      });
    }
    setIsConverting(false);
  };

  const has3D = useMemo(() => {
    return selectedFiles.some(sf => 
      FORMAT_CATEGORIES["3D Model"].includes(sf.targetFormat) || 
      sf.file.name.toLowerCase().match(/\.(glb|gltf|obj|stl|fbx|dae)$/)
    );
  }, [selectedFiles]);

  const active3DFile = useMemo(() => {
    return selectedFiles.find(sf => 
      sf.file.name.toLowerCase().match(/\.(glb|gltf|obj)$/)
    )?.file;
  }, [selectedFiles]);

  const renderNodeTree = (nodes: SceneNode[], depth = 0) => {
    return nodes.map((node) => (
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
  };

  return (
    <main 
      className="max-w-[1400px] mx-auto px-6 py-12"
      onPointerMove={resize}
      onPointerUp={stopResizing}
      onPointerLeave={stopResizing}
    >
      {/* Hero */}
      <section className="text-center mb-16">
        <h1 className="text-5xl md:text-8xl font-black tracking-tighter mb-6 leading-none uppercase">
          Convert <span className="text-[#e11d48]">Any</span> File.
        </h1>
        <p className="text-xl text-neutral-400 max-w-2xl mx-auto font-medium">
          Professional-grade browser-based conversion. 
          <span className="text-white font-bold italic block mt-2 tracking-wide">Zero costs. Zero limits. Total Privacy.</span>
        </p>
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
            <div className="p-6">
              <div className="space-y-3 mb-8">
                {selectedFiles.map((sf) => (
                  <motion.div key={sf.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between p-4 bg-black/20 rounded-2xl border border-white/5">
                    <div className="flex items-center gap-4 flex-1">
                      <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center border border-white/10">
                        {sf.file.name.toLowerCase().match(/\.(glb|obj|stl)$/) ? <Box className="w-5 h-5 text-purple-400" /> : <FileVideo className="w-5 h-5 text-blue-400" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-bold truncate pr-4 text-sm">{sf.file.name}</p>
                          {sf.status === 'processing' && <CircleDashed className="w-3 h-3 text-[#e11d48] animate-spin" />}
                          {sf.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-emerald-500" />}
                          {sf.status === 'error' && <AlertCircle className="w-3 h-3 text-[#e11d48]" />}
                        </div>
                        <p className={cn("text-[10px] font-black uppercase tracking-widest", sf.status === 'error' ? "text-[#e11d48]" : "text-neutral-500")}>
                          {sf.status === 'processing' ? `Processing ${sf.progress}%` : sf.status === 'error' ? (sf.error || "Error") : `${(sf.file.size / 1024).toFixed(0)} KB`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded border border-white/10 text-[10px] font-black uppercase tracking-widest">{sf.file.name.split('.').pop()?.toUpperCase()}</div>
                        <ArrowRight className="w-4 h-4 text-neutral-600" />
                        <FormatDropdown value={sf.targetFormat} onChange={(val) => updateFormat(sf.id, val)} sourceFileName={sf.file.name} />
                      </div>
                      <div className="flex items-center gap-2 border-l border-white/10 pl-6">
                        <button className="p-2 hover:bg-white/5 rounded-lg transition-colors text-neutral-500 hover:text-[#e11d48]" onClick={() => removeFile(sf.id)}><X className="w-5 h-5" /></button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-6 border-t border-white/5">
                <div className="flex items-center gap-4">
                  <button onClick={() => fileInputRef.current?.click()} disabled={isConverting} className="flex items-center gap-2 px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all disabled:opacity-50"><Plus className="w-4 h-4" /> Add More</button>
                  <StatusBadge label="Engine" ready={isMediaReady} />
                </div>
                <button onClick={handleConvertAll} disabled={isConverting || selectedFiles.every(f => !f.targetFormat)} className="px-12 py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-xl font-black text-lg shadow-xl shadow-[#e11d48]/20 flex items-center gap-3 group transition-all disabled:opacity-50 disabled:grayscale">
                  {isConverting ? "CONVERTING..." : "CONVERT ALL"}
                  <Zap className={cn("w-5 h-5 fill-white group-hover:scale-125 transition-transform", isConverting && "animate-pulse")} />
                </button>
              </div>
            </div>
          ) : (
            <div onClick={() => fileInputRef.current?.click()} className="p-32 flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-24 h-24 bg-white/5 rounded-[2rem] border border-white/10 flex items-center justify-center mb-8 group-hover:scale-110 group-hover:bg-[#e11d48] group-hover:border-[#e11d48] transition-all duration-500 shadow-2xl"><Upload className="w-10 h-10 text-neutral-400 group-hover:text-white" /></div>
              <h2 className="text-3xl font-black tracking-tight mb-2 uppercase">Drop your files</h2>
              <p className="text-neutral-500 font-bold mb-10 tracking-widest uppercase text-xs">or click to browse the system.</p>
              <button className="px-10 py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-xl font-black text-lg shadow-xl shadow-[#e11d48]/20 flex items-center gap-3 transition-all">SELECT FILE <ChevronDown className="w-4 h-4" /></button>
            </div>
          )}
        </div>
        <input type="file" ref={fileInputRef} multiple onChange={(e) => e.target.files && addFiles(e.target.files)} className="hidden" />
      </section>

      {/* 3D Forge Section */}
      <AnimatePresence>
        {has3D && (
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
                  </div>
                </div>
                {active3DFile && (
                  <button onClick={() => viewerRef.current?.exportGLB()} className="flex items-center gap-3 px-8 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-sm font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-900/40 active:scale-95 group shrink-0">
                    <Download className="w-4 h-4 group-hover:animate-bounce" /> Export Master Model
                  </button>
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
                  {active3DFile ? (
                     <ThreeDViewer ref={viewerRef} file={active3DFile} onNodesLoaded={setSceneNodes} hiddenNodes={hiddenNodes} backgroundColor={viewportTheme.color} />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full bg-[#16191d]">
                      <Box className="w-32 h-32 text-white/5 animate-pulse" />
                      <p className="text-neutral-500 font-bold tracking-widest uppercase text-xs mt-4">Awaiting 3D Input</p>
                    </div>
                  )}

                  <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="absolute top-4 left-4 z-40 bg-[#1f2228]/95 backdrop-blur-xl border border-white/10 p-3 rounded-xl text-neutral-400 hover:text-white transition-all shadow-2xl pointer-events-auto active:scale-95">
                    <motion.div animate={{ rotate: isSidebarOpen ? 180 : 0 }}><ArrowRight className="w-4 h-4" /></motion.div>
                  </button>

                  <div className="absolute bottom-8 left-8 right-8 flex items-center justify-between p-5 bg-[#1f2228]/90 backdrop-blur-xl rounded-2xl border border-white/10 pointer-events-none shadow-2xl z-20">
                     <div className="flex items-center gap-5">
                        <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.5)]" />
                        <div className="flex flex-col"><p className="text-xs font-black text-white uppercase tracking-wider">Active Workspace</p><p className="text-[10px] font-bold text-neutral-400 italic truncate max-w-[300px]">{active3DFile ? active3DFile.name : "Waiting..."}</p></div>
                     </div>
                     <div className="flex items-center gap-6">
                        <div className="flex flex-col items-end"><p className="text-[10px] font-black uppercase text-neutral-500 tracking-widest">Nodes</p><p className="text-sm font-black text-[#e11d48]">{hiddenNodes.length}</p></div>
                        <div className="h-8 w-px bg-white/10 mx-2" />
                        <div className="flex flex-col items-end"><p className="text-[10px] font-black uppercase text-neutral-500 tracking-widest">Environment</p><p className="text-xs font-bold text-emerald-500 uppercase">{viewportTheme.name}</p></div>
                     </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </main>
  );
}
