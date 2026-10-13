"use client";

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from "react";
import * as THREE from "three";
import { Loader2, AlertCircle } from "lucide-react";
import { downloadBlob } from "@/lib/utils";
import { useWorkers } from "@/hooks/use-workers";
import { useThreeScene, type GizmoMode, type Projection } from "@/hooks/use-three-scene";
import { ModelCatalog } from "@/components/converter/model-catalog";
import {
  discoverModels,
  loadModelObject,
  exportModel,
  revokeTextures,
  selectPrimaryModels,
  type DiscoveredModel,
  type ExportOptions,
} from "@/lib/3d-converter";
import {
  applyFitScale,
  arrangeModels,
  fitScaleFor,
  resetTransform,
  stageExport,
  NOTHING_VISIBLE,
} from "@/lib/3d-scene";
import {
  applyMaterialFixes,
  applyDisplayMode,
  collectStats,
  createTextureResolver,
  flipYForModel,
  hasAuthoredMaterials,
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
  /** Name of the model the gizmo is attached to, or null. */
  onSelection?: (name: string | null) => void;
  hiddenNodes?: string[];
  backgroundColor?: string;
  displayMode?: DisplayMode;
  unlit?: boolean;
  projection?: Projection;
  gizmoMode?: GizmoMode;
  /** Normalise every model to the same size (off keeps authored proportions). */
  fitScale?: boolean;
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
  /** Rows every visible model up on the grid so nothing overlaps. */
  arrange: () => void;
  /** Drops the selected model (or all of them) back to the origin. */
  resetTransforms: (scope: "selected" | "all") => void;
}

const ThreeDViewer = forwardRef<ThreeDViewerHandle, ThreeDViewerProps>(({
  files,
  textures: providedTextures = {},
  onNodesLoaded,
  onStats,
  onAnimations,
  onAnimationTime,
  onConsoleModel,
  onSelection,
  hiddenNodes = [],
  backgroundColor = "#d1d5db",
  displayMode = "shaded",
  unlit = false,
  projection = "perspective",
  gizmoMode = "translate",
  fitScale = true,
  activeClip = null,
  isPlaying = true,
}, ref) => {
  const { nintendoWorker } = useWorkers("nintendo");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<InternalModel[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadedModelsMap = useRef<Map<string, THREE.Group>>(new Map());
  const textureMapsRef = useRef<TextureMap[]>([]);
  const discoveryToken = useRef(0);
  const mixersRef = useRef<THREE.AnimationMixer[]>([]);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;

  const onFrame = useCallback((delta: number) => {
    if (mixersRef.current.length === 0) return;
    if (playingRef.current) {
      for (const mixer of mixersRef.current) mixer.update(delta);
      if (actionRef.current) onAnimationTime?.(actionRef.current.time);
    }
  }, [onAnimationTime]);

  // A model dragged by hand keeps its place through fit-scale switches and
  // auto-layout passes.
  const onTransform = useCallback((model: THREE.Object3D) => {
    model.userData.omniMoved = true;
  }, []);

  const onPick = useCallback((model: THREE.Object3D | null) => {
    setSelectedId((model?.userData?.omniModelId as string | undefined) ?? null);
  }, []);

  const {
    containerRef, sceneRef, modelsGroupRef, frameCamera, setProjection, attachGizmo, setGizmoMode,
  } = useThreeScene({ backgroundColor, onFrame, onPick, onTransform });

  const unlitRef = useRef(unlit);
  unlitRef.current = unlit;

  useEffect(() => { setProjection(projection); }, [projection, setProjection]);
  useEffect(() => { setGizmoMode(gizmoMode); }, [gizmoMode, setGizmoMode]);
  useEffect(() => {
    applyDisplayMode(modelsGroupRef.current, displayMode, unlit);
  }, [displayMode, unlit, modelsGroupRef, discoveredModels]);

  const visiblePivots = useCallback(() => (
    discoveredModels
      .filter((m) => m.visible)
      .map((m) => loadedModelsMap.current.get(m.id))
      .filter((pivot): pivot is THREE.Group => Boolean(pivot))
  ), [discoveredModels]);

  /**
   * Models the viewport may lay out on its own: several separate subjects that
   * nobody has placed by hand. Console containers are left alone — their parts
   * belong to one subject, and rowing them up would take a vehicle apart.
   */
  const autoLayoutPivots = useCallback(() => {
    const visible = discoveredModels.filter((m) => m.visible);
    if (visible.some((m) => m.path.toLowerCase().endsWith(".mdl0"))) return [];
    const pivots = visiblePivots();
    if (pivots.length < 2 || pivots.some((pivot) => pivot.userData.omniMoved)) return [];
    return pivots;
  }, [discoveredModels, visiblePivots]);

  // Gizmo follows the selection; a hidden or unloaded model cannot hold it.
  useEffect(() => {
    const pivot = selectedId ? loadedModelsMap.current.get(selectedId) : null;
    const mounted = pivot && pivot.parent === modelsGroupRef.current ? pivot : null;
    attachGizmo(mounted);
    onSelection?.(mounted ? discoveredModels.find((m) => m.id === selectedId)?.name ?? null : null);
    if (selectedId && !mounted) setSelectedId(null);
  }, [selectedId, discoveredModels, attachGizmo, onSelection, modelsGroupRef]);

  // Escape clears the selection so the gizmo gets out of the way.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fit scale is a scene-wide choice; hand-placed models keep their own. A
  // rescale changes how much room each model needs, so an untouched row of
  // models is laid out again rather than left overlapping.
  useEffect(() => {
    for (const pivot of visiblePivots()) applyFitScale(pivot, fitScale);
    arrangeModels(autoLayoutPivots());
    onStats?.(collectStats(modelsGroupRef.current));
  }, [fitScale, visiblePivots, autoLayoutPivots, onStats, modelsGroupRef]);

  useImperativeHandle(ref, () => ({
    exportGLB: async (format = "glb", customName?: string, options?: ExportOptions) => {
      const lowerFormat = format.toLowerCase();
      // Export the authored materials, never the wireframe/normal preview, and
      // only the geometry the viewport is actually showing.
      applyDisplayMode(modelsGroupRef.current, "shaded", false);
      const staged = stageExport(modelsGroupRef.current);
      try {
        if (staged.meshes === 0) throw new Error(NOTHING_VISIBLE);
        const blob = await exportModel(modelsGroupRef.current, lowerFormat, {
          ...options,
          includeHidden: true,
        });
        downloadBlob(blob, customName || `Omni_Export_${Date.now()}.${lowerFormat}`);
      } finally {
        staged.restore();
        applyDisplayMode(modelsGroupRef.current, displayMode, unlitRef.current);
      }
    },
    frameCamera,
    seekAnimation: (time: number) => {
      if (!actionRef.current) return;
      actionRef.current.time = time;
      for (const mixer of mixersRef.current) mixer.update(0);
    },
    arrange: () => {
      arrangeModels(visiblePivots());
      frameCamera();
    },
    resetTransforms: (scope) => {
      const pivots = scope === "all"
        ? visiblePivots()
        : visiblePivots().filter((pivot) => pivot.userData.omniModelId === selectedId);
      for (const pivot of pivots) resetTransform(pivot, fitScaleRef.current);
      frameCamera();
    },
  }));

  const applyVisibility = useCallback(() => {
    // Rows are keyed on uuid; the synthetic "root" row toggles the whole scene.
    // Matching on name would hide same-named meshes in every other model too.
    const hideAll = hiddenNodes.includes("root");
    modelsGroupRef.current.traverse((child) => {
      if (child === modelsGroupRef.current) return;
      child.visible = !hideAll && !hiddenNodes.includes(child.uuid);
    });
  }, [hiddenNodes, modelsGroupRef]);

  useEffect(() => { applyVisibility(); }, [applyVisibility]);

  // Hiding a node changes what an export would write, so the HUD follows it.
  useEffect(() => {
    onStats?.(collectStats(modelsGroupRef.current));
  }, [hiddenNodes, onStats, modelsGroupRef]);

  const updateNodeTree = useCallback(() => {
    let totalCount = 0;
    const extract = (obj: THREE.Object3D): SceneNode => {
      totalCount++;
      return { id: obj.uuid, name: obj.name || obj.type, type: obj.type, children: obj.children.map(extract) };
    };
    const rootNodes = Array.from(loadedModelsMap.current.entries())
      .filter(([, group]) => group.parent === modelsGroupRef.current && group.children[0])
      .map(([id, group]) => {
        const node = extract(group.children[0]);
        // Loaders often leave a model's own root unnamed (MDL0 roots fall back
        // to a uuid), which reads like a detail rather than the whole model.
        const model = discoveredModels.find((m) => m.id === id);
        return model ? { ...node, name: model.name } : node;
      });
    onNodesLoaded?.([{ id: "root", name: "Scene", type: "Scene", count: totalCount, children: rootNodes }]);
    onStats?.(collectStats(modelsGroupRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNodesLoaded, onStats, modelsGroupRef, discoveredModels]);

  // Rebuilds the mixer set whenever the visible models change.
  const syncAnimations = useCallback(() => {
    mixersRef.current = [];
    actionRef.current = null;
    const clips: { name: string; duration: number }[] = [];

    loadedModelsMap.current.forEach((pivot) => {
      if (pivot.parent !== modelsGroupRef.current) return;
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
  }, [onAnimations, modelsGroupRef]);

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
          // Every model stays in the catalogue, but each dropped file opens on
          // its own subject rather than on whichever LOD or vertex-colour bake
          // happens to come first in the archive. Several files therefore show
          // side by side, which is the point of composing a scene.
          const opensWith = selectPrimaryModels(models)[0]?.path;
          for (const model of models) {
            found.push({
              ...model,
              id: `${file.name}:${model.path}`,
              visible: model.path === opensWith,
            });
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
      let mounted = 0;
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
        const fixOptions = {
          flipY: flipYForModel(modelInfo.path),
          respectAuthored: hasAuthoredMaterials(modelInfo.path),
        };
        // Re-run the material pass once every queued texture has settled.
        manager.onLoad = () => {
          if (!loaded) return;
          applyMaterialFixes(loaded, modelInfo.textures, textureLoader, fixOptions);
          applyDisplayMode(modelsGroupRef.current, displayMode, unlitRef.current);
        };

        try {
          const object = await loadModelObject(modelInfo.file, manager, nintendoWorker);
          if (cancelled) {
            disposeObject(object);
            return;
          }
          loaded = object;
          applyMaterialFixes(object, modelInfo.textures, textureLoader, fixOptions);

          const pivot = new THREE.Group();
          pivot.add(object);
          pivot.userData.omniModelId = modelInfo.id;

          const box = new THREE.Box3().setFromObject(object);
          const center = new THREE.Vector3();
          box.getCenter(center);
          object.position.set(-center.x, -center.y, -center.z);
          pivot.userData.omniFit = fitScaleFor(object);
          applyFitScale(pivot, fitScaleRef.current);

          loadedModelsMap.current.set(modelInfo.id, pivot);
          modelsGroupRef.current.add(pivot);
          mounted++;
          applyVisibility();
        } catch (e) {
          console.error(`[Viewer] Failed to load ${modelInfo.name}:`, e);
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      if (!cancelled) {
        // Freshly mounted models all sit at the origin; spread them out so a
        // multi-model scene is usable before the user touches the gizmo.
        if (mounted > 0) arrangeModels(autoLayoutPivots());
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

  const setAllVisible = (visible: boolean) => {
    setDiscoveredModels(prev => prev.map(m => ({ ...m, visible })));
  };

  return (
    <div ref={containerRef} className="w-full h-full relative outline-none bg-transparent overflow-hidden">
      {loading && <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f1115]/95 backdrop-blur-md z-10"><Loader2 className="w-16 h-12 text-[#e11d48] animate-spin mb-4" /><p className="text-neutral-400 font-black uppercase text-[10px] tracking-[0.2em] animate-pulse">Initializing Multiverse...</p></div>}
      {error && <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md z-10 p-6 text-center border-t border-[#e11d48]/10"><AlertCircle className="w-16 h-12 text-[#e11d48] mb-4 animate-pulse" /><p className="text-white font-black tracking-tight text-xl italic mb-6">{error}</p><button onClick={() => window.location.reload()} className="px-8 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">Retry Engine</button></div>}

      {!loading && (
        <ModelCatalog
          models={discoveredModels}
          selectedId={selectedId}
          isOpen={isMenuOpen}
          onOpenChange={setIsMenuOpen}
          onToggle={toggleModelVisibility}
          onSelect={setSelectedId}
          onSetAll={setAllVisible}
        />
      )}
    </div>
  );
});

ThreeDViewer.displayName = "ThreeDViewer";
export default ThreeDViewer;
