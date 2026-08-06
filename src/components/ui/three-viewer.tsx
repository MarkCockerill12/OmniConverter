"use client";

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from "react";
import * as THREE from "three";
import { Loader2, AlertCircle, Layers, Check, X, Eye, EyeOff } from "lucide-react";
import { cn, downloadBlob } from "@/lib/utils";
import { useWorkers } from "@/hooks/use-workers";
import { useThreeScene, type Projection } from "@/hooks/use-three-scene";
import {
  discoverModels,
  loadModelObject,
  exportModel,
  revokeTextures,
  type DiscoveredModel,
  type ExportOptions,
} from "@/lib/3d-converter";
import {
  applyMaterialFixes,
  applyDisplayMode,
  collectStats,
  createTextureResolver,
  disposeObject,
  isConsoleModel,
  type DisplayMode,
  type SceneStats,
  type TextureMap,
} from "@/lib/3d-materials";

interface ThreeDViewerProps {
  files: File[];
  textures?: Record<string, TextureMap>; // filename -> (subfilename -> blob url)
  onNodesLoaded?: (nodes: SceneNode[]) => void;
  onStats?: (stats: SceneStats) => void;
  onAnimations?: (clips: { name: string; duration: number }[]) => void;
  onAnimationTime?: (time: number) => void;
  /** Fired when a console model is detected, so the UI can default to unlit. */
  onConsoleModel?: (isConsole: boolean) => void;
  hiddenNodes?: string[];
  backgroundColor?: string;
  displayMode?: DisplayMode;
  unlit?: boolean;
  projection?: Projection;
  activeClip?: string | null;
  isPlaying?: boolean;
}

export interface SceneNode {
  id: string;
  name: string;
  type: string;
  count?: number;
  children: SceneNode[];
}

interface InternalModel extends DiscoveredModel {
  id: string;
  visible: boolean;
}

export interface ThreeDViewerHandle {
  exportGLB: (format?: string, customName?: string, options?: ExportOptions) => Promise<void>;
  frameCamera: () => void;
  seekAnimation: (time: number) => void;
}

const ThreeDViewer = forwardRef<ThreeDViewerHandle, ThreeDViewerProps>(({
  files,
  textures: providedTextures = {},
  onNodesLoaded,
  onStats,
  onAnimations,
  onAnimationTime,
  onConsoleModel,
  hiddenNodes = [],
  backgroundColor = "#d1d5db",
  displayMode = "shaded",
  unlit = false,
  projection = "perspective",
  activeClip = null,
  isPlaying = true,
}, ref) => {
  const { nintendoWorker } = useWorkers("nintendo");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<InternalModel[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const loadedModelsMap = useRef<Map<string, THREE.Group>>(new Map());
  const textureMapsRef = useRef<TextureMap[]>([]);
  const discoveryToken = useRef(0);
  const mixersRef = useRef<THREE.AnimationMixer[]>([]);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  const onFrame = useCallback((delta: number) => {
    if (mixersRef.current.length === 0) return;
    if (playingRef.current) {
      for (const mixer of mixersRef.current) mixer.update(delta);
      if (actionRef.current) onAnimationTime?.(actionRef.current.time);
    }
  }, [onAnimationTime]);

  const { containerRef, sceneRef, modelsGroupRef, frameCamera, setProjection } = useThreeScene({
    backgroundColor,
    onFrame,
  });

  const unlitRef = useRef(unlit);
  unlitRef.current = unlit;

  useEffect(() => { setProjection(projection); }, [projection, setProjection]);
  useEffect(() => {
    applyDisplayMode(modelsGroupRef.current, displayMode, unlit);
  }, [displayMode, unlit, modelsGroupRef, discoveredModels]);

  useImperativeHandle(ref, () => ({
    exportGLB: async (format = "glb", customName?: string, options?: ExportOptions) => {
      const lowerFormat = format.toLowerCase();
      // Export the authored materials, never the wireframe/normal preview.
      applyDisplayMode(modelsGroupRef.current, "shaded", false);
      try {
        const blob = await exportModel(modelsGroupRef.current, lowerFormat, options);
        downloadBlob(blob, customName || `Omni_Export_${Date.now()}.${lowerFormat}`);
      } finally {
        applyDisplayMode(modelsGroupRef.current, displayMode, unlitRef.current);
      }
    },
    frameCamera,
    seekAnimation: (time: number) => {
      if (!actionRef.current) return;
      actionRef.current.time = time;
      for (const mixer of mixersRef.current) mixer.update(0);
    },
  }));

  const applyVisibility = useCallback(() => {
    modelsGroupRef.current.traverse((child) => {
      child.visible = !(hiddenNodes.includes(child.uuid) || hiddenNodes.includes(child.name));
    });
  }, [hiddenNodes, modelsGroupRef]);

  useEffect(() => { applyVisibility(); }, [applyVisibility]);

  const updateNodeTree = useCallback(() => {
    let totalCount = 0;
    const extract = (obj: THREE.Object3D): SceneNode => {
      totalCount++;
      return { id: obj.uuid, name: obj.name || obj.type, type: obj.type, children: obj.children.map(extract) };
    };
    const rootNodes = Array.from(loadedModelsMap.current.values())
      .map((group) => group.children[0])
      .filter(Boolean)
      .map(extract);
    onNodesLoaded?.([{ id: "root", name: "Scene", type: "Scene", count: totalCount, children: rootNodes }]);
    onStats?.(collectStats(modelsGroupRef.current));
  }, [onNodesLoaded, onStats, modelsGroupRef]);

  // Rebuilds the mixer set whenever the visible models change.
  const syncAnimations = useCallback(() => {
    mixersRef.current = [];
    actionRef.current = null;
    const clips: { name: string; duration: number }[] = [];

    loadedModelsMap.current.forEach((pivot) => {
      const model = pivot.children[0] as THREE.Object3D | undefined;
      const animations = (model?.userData?.animations || []) as THREE.AnimationClip[];
      if (!model || animations.length === 0) return;
      const mixer = new THREE.AnimationMixer(model);
      mixersRef.current.push(mixer);
      for (const clip of animations) {
        clips.push({ name: clip.name || `Clip ${clips.length + 1}`, duration: clip.duration });
        (mixer as any).omniClips = animations;
      }
    });
    onAnimations?.(clips);
  }, [onAnimations]);

  // Starts (or swaps) the selected clip.
  useEffect(() => {
    for (const mixer of mixersRef.current) {
      mixer.stopAllAction();
      const clips = ((mixer as any).omniClips || []) as THREE.AnimationClip[];
      const clip = activeClip ? clips.find((c) => c.name === activeClip) : clips[0];
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      action.reset().play();
      if (!actionRef.current) actionRef.current = action;
    }
  }, [activeClip, discoveredModels]);

  // 1. DISCOVERY — expands archives and lists every model found inside them.
  useEffect(() => {
    if (!files || files.length === 0) return;
    const token = ++discoveryToken.current;

    (async () => {
      try {
        setLoading(true);
        const found: InternalModel[] = [];
        for (const file of files) {
          const models = await discoverModels(file, {
            textures: providedTextures[file.name],
            nintendoWorker,
          });
          for (const model of models) {
            found.push({ ...model, id: `${file.name}:${model.path}`, visible: found.length === 0 });
          }
        }

        if (token !== discoveryToken.current) {
          new Set(found.map((m) => m.textures)).forEach(revokeTextures);
          return;
        }

        textureMapsRef.current.forEach(revokeTextures);
        textureMapsRef.current = Array.from(new Set(found.map((m) => m.textures)));

        if (found.length === 0) {
          setError("No 3D models found.");
          setLoading(false);
        } else {
          setDiscoveredModels(found);
          setError(null);
        }
      } catch (e) {
        console.error("[Viewer] Discovery failed:", e);
        setError("Archive Error");
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, nintendoWorker]);

  useEffect(() => () => { textureMapsRef.current.forEach(revokeTextures); }, []);

  // 2. MODEL SYNCHRONISER — mounts/unmounts models as the catalog changes.
  useEffect(() => {
    if (!sceneRef.current || discoveredModels.length === 0) return;

    const knownIds = new Set(discoveredModels.map((m) => m.id));
    const visibleIds = new Set(discoveredModels.filter((m) => m.visible).map((m) => m.id));
    loadedModelsMap.current.forEach((group, id) => {
      if (!knownIds.has(id)) {
        modelsGroupRef.current.remove(group);
        disposeObject(group);
        loadedModelsMap.current.delete(id);
      } else if (!visibleIds.has(id)) {
        modelsGroupRef.current.remove(group);
      }
    });

    let cancelled = false;
    (async () => {
      for (const modelInfo of discoveredModels) {
        if (cancelled) return;
        if (!modelInfo.visible) continue;

        const cached = loadedModelsMap.current.get(modelInfo.id);
        if (cached) {
          modelsGroupRef.current.add(cached);
          continue;
        }

        setLoading(true);
        let loaded: THREE.Object3D | null = null;
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(createTextureResolver(modelInfo.textures, modelInfo.path));
        const textureLoader = new THREE.TextureLoader(manager);
        // Re-run the material pass once every queued texture has settled.
        manager.onLoad = () => {
          if (!loaded) return;
          applyMaterialFixes(loaded, modelInfo.textures, textureLoader);
          applyDisplayMode(modelsGroupRef.current, displayMode, unlitRef.current);
        };

        try {
          const object = await loadModelObject(modelInfo.file, manager, nintendoWorker);
          if (cancelled) {
            disposeObject(object);
            return;
          }
          loaded = object;
          applyMaterialFixes(object, modelInfo.textures, textureLoader);

          const pivot = new THREE.Group();
          pivot.add(object);

          const box = new THREE.Box3().setFromObject(object);
          const center = new THREE.Vector3();
          const size = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);
          object.position.set(-center.x, -center.y, -center.z);
          const maxDim = Math.max(size.x, size.y, size.z);
          if (maxDim > 0) pivot.scale.setScalar(12 / maxDim);

          loadedModelsMap.current.set(modelInfo.id, pivot);
          modelsGroupRef.current.add(pivot);
          applyVisibility();
        } catch (e) {
          console.error(`[Viewer] Failed to load ${modelInfo.name}:`, e);
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      if (!cancelled) {
        applyVisibility();
        onConsoleModel?.(isConsoleModel(modelsGroupRef.current));
        applyDisplayMode(modelsGroupRef.current, displayMode, unlitRef.current);
        syncAnimations();
        updateNodeTree();
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveredModels]);

  const toggleModelVisibility = (id: string) => {
    setDiscoveredModels(prev => prev.map(m => m.id === id ? { ...m, visible: !m.visible } : m));
  };

  return (
    <div ref={containerRef} className="w-full h-full relative outline-none bg-transparent overflow-hidden">
      {loading && <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f1115]/95 backdrop-blur-md z-10"><Loader2 className="w-16 h-12 text-[#e11d48] animate-spin mb-4" /><p className="text-neutral-400 font-black uppercase text-[10px] tracking-[0.2em] animate-pulse">Initializing Multiverse...</p></div>}
      {error && <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md z-10 p-6 text-center border-t border-[#e11d48]/10"><AlertCircle className="w-16 h-12 text-[#e11d48] mb-4 animate-pulse" /><p className="text-white font-black tracking-tight text-xl italic mb-6">{error}</p><button onClick={() => window.location.reload()} className="px-8 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">Retry Engine</button></div>}

      {!loading && discoveredModels.length > 0 && (
        <div className="absolute top-4 right-4 z-50 flex flex-col items-end gap-2">
           <button onClick={() => setIsMenuOpen(!isMenuOpen)} className={cn("p-3 rounded-xl backdrop-blur-xl border transition-all shadow-2xl flex items-center gap-3", isMenuOpen ? "bg-[#e11d48] border-[#e11d48] text-white" : "bg-[#1f2228]/95 border-white/10 text-neutral-400 hover:text-white")}><Layers className="w-4 h-4" /><span className="text-[10px] font-black uppercase tracking-widest pr-1">Models ({discoveredModels.filter(m => m.visible).length}/{discoveredModels.length})</span></button>
           {isMenuOpen && (
             <div className="w-64 bg-[#1f2228]/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="p-3 border-b border-white/5 bg-white/5 flex items-center justify-between"><p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Mesh Catalog</p><button onClick={() => setIsMenuOpen(false)} className="text-neutral-500 hover:text-white"><X className="w-4 h-4" /></button></div>
                <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
                   {discoveredModels.map((model) => (
                     <button key={model.id} onClick={() => toggleModelVisibility(model.id)} className="w-full flex items-center gap-3 p-3 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 text-left">
                        <div className={cn("w-4 h-4 rounded border flex items-center justify-center transition-all", model.visible ? "bg-emerald-500 border-emerald-500 text-white" : "border-white/20 text-transparent")}><Check className="w-3 h-3 stroke-[4px]" /></div>
                        <div className="flex-1 min-w-0"><p className={cn("text-xs font-bold truncate", model.visible ? "text-white" : "text-neutral-500")}>{model.name}</p><p className="text-[8px] font-black uppercase tracking-tighter text-neutral-600 truncate">{model.sourceName}</p></div>
                        {model.visible ? <Eye className="w-3.5 h-3.5 text-emerald-500" /> : <EyeOff className="w-3.5 h-3.5 text-neutral-600" />}
                     </button>
                   ))}
                </div>
             </div>
           )}
        </div>
      )}
    </div>
  );
});

ThreeDViewer.displayName = "ThreeDViewer";
export default ThreeDViewer;
