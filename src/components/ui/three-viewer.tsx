"use client";

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { Box, Loader2, AlertCircle } from "lucide-react";

interface ThreeDViewerProps {
  file: File;
  onNodesLoaded?: (nodes: SceneNode[]) => void;
  hiddenNodes?: string[];
  backgroundColor?: string;
}

export interface SceneNode {
  id: string;
  name: string;
  type: string;
  children: SceneNode[];
}

export interface ThreeDViewerHandle {
  exportGLB: () => Promise<void>;
}

const ThreeDViewer = forwardRef<ThreeDViewerHandle, ThreeDViewerProps>(({ 
  file, 
  onNodesLoaded, 
  hiddenNodes = [],
  backgroundColor = "#d1d5db"
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const sceneRef = useRef<THREE.Scene | null>(null);
  const pivotRef = useRef<THREE.Group | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const updateGrid = (scene: THREE.Scene, bgColor: string) => {
    const oldGrid = scene.getObjectByName('scene-grid');
    if (oldGrid) scene.remove(oldGrid);

    const color = new THREE.Color(bgColor);
    const isDark = (color.r * 0.299 + color.g * 0.587 + color.b * 0.114) < 0.5;
    const gridColor = isDark ? 0xffffff : 0x000000;
    const grid = new THREE.GridHelper(50, 50, gridColor, gridColor);
    grid.name = 'scene-grid';
    grid.material.transparent = true;
    grid.material.opacity = isDark ? 0.1 : 0.2;
    scene.add(grid);
  };

  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.background = new THREE.Color(backgroundColor);
      updateGrid(sceneRef.current, backgroundColor);
    }
  }, [backgroundColor]);

  useImperativeHandle(ref, () => ({
    exportGLB: async () => {
      if (!pivotRef.current) return;
      const exporter = new GLTFExporter();
      exporter.parse(
        pivotRef.current,
        (result) => {
          const blob = new Blob([result as any], { type: 'model/gltf-binary' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `modified_${file.name.split('.')[0]}.glb`;
          a.click();
          URL.revokeObjectURL(url);
        },
        (error) => console.error('Export error:', error),
        { binary: true }
      );
    }
  }));

  useEffect(() => {
    if (!pivotRef.current) return;
    pivotRef.current.traverse((child) => {
      if (hiddenNodes.includes(child.uuid) || hiddenNodes.includes(child.name)) {
        child.visible = false;
      } else {
        child.visible = true;
      }
    });
  }, [hiddenNodes]);

  useEffect(() => {
    if (!containerRef.current || !file) return;

    setLoading(true);
    setError(null);

    const container = containerRef.current;
    
    // 1. Scene Setup
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(backgroundColor);
    updateGrid(scene, backgroundColor);

    // 2. Camera Setup
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(10, 10, 10);
    cameraRef.current = camera;

    // 3. Renderer Setup - High Stability
    const renderer = new THREE.WebGLRenderer({ 
      antialias: true, 
      alpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false // Prevent extra memory copy
    });
    rendererRef.current = renderer;
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    
    // CSS Force-Fill prevents the "black box" flickering
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    
    container.appendChild(renderer.domElement);

    // 4. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    directionalLight.position.set(5, 10, 7);
    scene.add(directionalLight);

    // 5. Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;

    // 6. Loader
    const fileUrl = URL.createObjectURL(file);
    const extension = file.name.split('.').pop()?.toLowerCase();

    const extractNodeTree = (obj: THREE.Object3D): SceneNode => ({
      id: obj.uuid,
      name: obj.name || obj.type,
      type: obj.type,
      children: obj.children.map(extractNodeTree)
    });

    const onLoad = (object: THREE.Object3D | any) => {
      const model = object.scene || object;
      if (onNodesLoaded) onNodesLoaded([extractNodeTree(model)]);

      model.traverse((child: any) => {
        if (child.isMesh) {
          child.material.side = THREE.DoubleSide;
          child.castShadow = true;
        }
      });

      const box = new THREE.Box3().setFromObject(model);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);

      model.position.set(-center.x, -center.y, -center.z);
      const pivot = new THREE.Group();
      pivotRef.current = pivot;
      pivot.add(model);
      scene.add(pivot);
      
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) {
        const scale = 5 / maxDim;
        pivot.scale.set(scale, scale, scale);
      }

      camera.position.set(10, 10, 10);
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
      setLoading(false);
      URL.revokeObjectURL(fileUrl);
    };

    if (extension === 'glb' || extension === 'gltf') {
      new GLTFLoader().load(fileUrl, onLoad, undefined, () => setError("Failed to load model."));
    } else if (extension === 'obj') {
      new OBJLoader().load(fileUrl, onLoad, undefined, () => setError("Failed to load model."));
    } else {
      setError(`Format .${extension} not supported.`);
      setLoading(false);
    }

    // 7. Animation Loop
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      if (controlsRef.current) controlsRef.current.update();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    // 8. Robust Resize (Sync to Animation Frame)
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries.length || !rendererRef.current || !cameraRef.current) return;
      const { width: w, height: h } = entries[0].contentRect;
      if (w === 0 || h === 0) return;

      requestAnimationFrame(() => {
        if (!cameraRef.current || !rendererRef.current) return;
        cameraRef.current.aspect = w / h;
        cameraRef.current.updateProjectionMatrix();
        // IMPORTANT: setSize(w, h, false) prevents CSS re-injection, stopping the flicker
        rendererRef.current.setSize(w, h, false);
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(animationId);
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (container.contains(rendererRef.current.domElement)) {
          container.removeChild(rendererRef.current.domElement);
        }
      }
      scene.clear();
      pivotRef.current = null;
      sceneRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, [file]);

  return (
    <div ref={containerRef} className="w-full h-full relative outline-none bg-transparent overflow-hidden">
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f1115]/40 backdrop-blur-sm z-10">
          <Loader2 className="w-12 h-12 text-[#e11d48] animate-spin mb-4" />
          <p className="text-neutral-400 font-bold tracking-widest uppercase text-[10px]">Synchronizing Workspace...</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md z-10 p-6 text-center">
          <AlertCircle className="w-12 h-12 text-[#e11d48] mb-4" />
          <p className="text-white font-black tracking-tight mb-2 text-lg">{error}</p>
        </div>
      )}
    </div>
  );
});

ThreeDViewer.displayName = "ThreeDViewer";
export default ThreeDViewer;
