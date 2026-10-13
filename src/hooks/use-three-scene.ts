"use client";

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

export type Projection = "perspective" | "orthographic";
export type GizmoMode = "translate" | "rotate" | "scale";

interface SceneOptions {
  backgroundColor: string;
  /** Called once per rendered frame with the elapsed time in seconds. */
  onFrame?: (delta: number) => void;
  /** Click in the viewport: the top-level model hit, or null for empty space. */
  onPick?: (model: THREE.Object3D | null) => void;
  /** Fired while the gizmo moves a model. */
  onTransform?: (model: THREE.Object3D) => void;
}

/**
 * Owns the WebGL engine for the 3D Forge: renderer, cameras, controls, grid and
 * the render loop. Kept separate from the viewer component so theme changes,
 * projection switches and camera framing never rebuild the GL context.
 */
export function useThreeScene({ backgroundColor, onFrame, onPick, onTransform }: SceneOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gizmoRef = useRef<TransformControls | null>(null);
  const gizmoModeRef = useRef<GizmoMode>("translate");
  const modelsGroupRef = useRef<THREE.Group>(new THREE.Group());
  const projectionRef = useRef<Projection>("perspective");
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const transformRef = useRef(onTransform);
  transformRef.current = onTransform;

  /**
   * Builds the move/rotate/scale gizmo for the active camera. Rebuilt whenever
   * the projection switches, since TransformControls is bound to one camera.
   */
  const buildGizmo = useCallback(() => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!camera || !renderer || !scene) return null;

    const previous = gizmoRef.current;
    const attached = previous?.object ?? null;
    if (previous) {
      scene.remove(previous.getHelper());
      previous.detach();
      previous.dispose();
    }

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setMode(gizmoModeRef.current);
    gizmo.setSize(0.8);
    gizmo.addEventListener("dragging-changed", (event) => {
      // Orbiting while dragging an axis fights the gizmo for the pointer.
      if (controlsRef.current) controlsRef.current.enabled = !event.value;
    });
    gizmo.addEventListener("objectChange", () => {
      if (gizmo.object) transformRef.current?.(gizmo.object);
    });
    scene.add(gizmo.getHelper());
    if (attached) gizmo.attach(attached);
    gizmoRef.current = gizmo;
    return gizmo;
  }, []);

  /** Points the gizmo at a model, or hides it when given null. */
  const attachGizmo = useCallback((model: THREE.Object3D | null) => {
    const gizmo = gizmoRef.current || buildGizmo();
    if (!gizmo) return;
    if (model) gizmo.attach(model);
    else gizmo.detach();
  }, [buildGizmo]);

  const setGizmoMode = useCallback((mode: GizmoMode) => {
    gizmoModeRef.current = mode;
    gizmoRef.current?.setMode(mode);
  }, []);

  /** Moves the active camera so the loaded models fill the viewport. */
  const frameCamera = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const box = new THREE.Box3().setFromObject(modelsGroupRef.current);
    if (box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    if (camera instanceof THREE.PerspectiveCamera) {
      const distance = (radius * 2.4) / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(0.01, distance / 1000);
      camera.far = distance * 100;
    } else if (camera instanceof THREE.OrthographicCamera) {
      const container = containerRef.current;
      const aspect = container && container.clientHeight ? container.clientWidth / container.clientHeight : 1;
      const extent = radius * 1.6;
      camera.left = -extent * aspect;
      camera.right = extent * aspect;
      camera.top = extent;
      camera.bottom = -extent;
      camera.position.copy(center).addScaledVector(direction, radius * 8);
    }
    (camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }, []);

  const setProjection = useCallback((mode: Projection) => {
    const container = containerRef.current;
    const renderer = rendererRef.current;
    const previous = cameraRef.current;
    if (!container || !renderer || !previous || projectionRef.current === mode) return;

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const camera = mode === "perspective"
      ? new THREE.PerspectiveCamera(45, aspect, 0.1, 50000)
      : new THREE.OrthographicCamera(-20 * aspect, 20 * aspect, 20, -20, 0.1, 50000);
    camera.position.copy(previous.position);
    camera.quaternion.copy(previous.quaternion);

    const target = controlsRef.current?.target.clone();
    controlsRef.current?.dispose();
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    if (target) controls.target.copy(target);
    controls.update();

    cameraRef.current = camera;
    controlsRef.current = controls;
    projectionRef.current = mode;
    buildGizmo();
    frameCamera();
  }, [buildGizmo, frameCamera]);

  // Engine — created once and kept alive for the lifetime of the viewport.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 50000);
    camera.position.set(25, 25, 25);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    rendererRef.current = renderer;
    renderer.setSize(container.clientWidth, container.clientHeight);
    // Retina panels gain nothing visible above 2x but cost 4x the fragments.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 2.0));
    const light = new THREE.DirectionalLight(0xffffff, 2.0);
    light.position.set(10, 50, 10);
    scene.add(light);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    const modelsGroup = modelsGroupRef.current;
    scene.add(modelsGroup);
    buildGizmo();

    // Click-to-select. A press that travels or lingers is an orbit, not a pick,
    // and a press that lands on the gizmo belongs to the gizmo.
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number; at: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      down = gizmoRef.current?.dragging ? null : { x: event.clientX, y: event.clientY, at: Date.now() };
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || !pickRef.current || !cameraRef.current) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      if (Date.now() - start.at > 500 || gizmoRef.current?.dragging) return;

      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1
        ),
        cameraRef.current
      );
      const hit = raycaster.intersectObjects(modelsGroup.children, true)[0];
      let model: THREE.Object3D | null = hit ? hit.object : null;
      while (model && model.parent && model.parent !== modelsGroup) model = model.parent;
      pickRef.current(model);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // Keep rendering continuously (textures and animations can update at any
    // time) but skip the work while the viewport is scrolled away or hidden.
    let onScreen = true;
    const io = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }, { threshold: 0 });
    io.observe(container);

    const clock = new THREE.Clock();
    let anim = 0;
    const loop = () => {
      anim = requestAnimationFrame(loop);
      const delta = clock.getDelta();
      if (!onScreen || document.hidden) return;
      frameRef.current?.(delta);
      controlsRef.current?.update();
      if (cameraRef.current) renderer.render(scene, cameraRef.current);
    };
    loop();

    const ro = new ResizeObserver((entries) => {
      if (!entries.length) return;
      const { width, height } = entries[0].contentRect;
      if (!width || !height) return;
      const active = cameraRef.current;
      if (active instanceof THREE.PerspectiveCamera) {
        active.aspect = width / height;
        active.updateProjectionMatrix();
      } else if (active instanceof THREE.OrthographicCamera) {
        const extent = (active.top - active.bottom) / 2;
        const aspect = width / height;
        active.left = -extent * aspect;
        active.right = extent * aspect;
        active.updateProjectionMatrix();
      }
      renderer.setSize(width, height, false);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      io.disconnect();
      cancelAnimationFrame(anim);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      gizmoRef.current?.detach();
      gizmoRef.current?.dispose();
      gizmoRef.current = null;
      controlsRef.current?.dispose();
      modelsGroup.clear();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
    // buildGizmo is stable; the engine must be created exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Atmosphere — swapping themes must not rebuild the WebGL context.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.background = new THREE.Color(backgroundColor);

    const oldGrid = scene.getObjectByName("scene-grid") as THREE.GridHelper | undefined;
    if (oldGrid) {
      scene.remove(oldGrid);
      oldGrid.geometry.dispose();
      (oldGrid.material as THREE.Material).dispose();
    }
    const color = new THREE.Color(backgroundColor);
    const isDark = color.r * 0.299 + color.g * 0.587 + color.b * 0.114 < 0.5;
    const gridColor = isDark ? 0xffffff : 0x000000;
    const grid = new THREE.GridHelper(100, 100, gridColor, gridColor);
    grid.name = "scene-grid";
    grid.material.transparent = true;
    grid.material.opacity = isDark ? 0.05 : 0.1;
    scene.add(grid);
  }, [backgroundColor]);

  return {
    containerRef,
    sceneRef,
    modelsGroupRef,
    cameraRef,
    gizmoRef,
    frameCamera,
    setProjection,
    attachGizmo,
    setGizmoMode,
  };
}
