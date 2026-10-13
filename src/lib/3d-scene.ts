import * as THREE from "three";

/**
 * Scene composition for the 3D Forge viewport: per-model placement, the fit
 * scale that keeps mixed sources comparable, and the staging pass that makes an
 * export mirror exactly what the viewport shows.
 */

/** Longest edge a single model is normalised to when "fit scale" is on. */
export const FIT_SIZE = 12;

/** Message surfaced when a prune leaves nothing behind. */
export const NOTHING_VISIBLE = "Nothing to export — every mesh is hidden in the viewport.";

/**
 * userData the viewport writes on live objects. GLTFExporter copies userData
 * into `extras`, so these have to be stashed away during an export: leaving
 * them in serialises cached materials (and their textures) into the file.
 */
const INTERNAL_KEYS = [
  "omniOriginalMaterial",
  "omniUnlitMaterial",
  "omniNormalMaterial",
  "omniUvMaterial",
  "animations",
  "omniFit",
  "omniMoved",
  "omniModelId",
];

/** Scale that fits an object's longest edge into `target` world units. */
export function fitScaleFor(object: THREE.Object3D, target = FIT_SIZE) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return 1;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  return maxDim > 0 ? target / maxDim : 1;
}

/**
 * Applies the pivot's stored fit factor, or its authored scale when the user
 * asked for real proportions. A model the user has scaled by hand is left alone.
 */
export function applyFitScale(pivot: THREE.Object3D, normalize: boolean) {
  if (pivot.userData.omniMoved) return;
  const fit = typeof pivot.userData.omniFit === "number" ? pivot.userData.omniFit : 1;
  pivot.scale.setScalar(normalize ? fit : 1);
  pivot.updateMatrixWorld(true);
}

/** Rows the given pivots up along X, sitting on the grid, without overlap. */
export function arrangeModels(pivots: THREE.Object3D[], gap = 1.5) {
  if (pivots.length === 0) return;

  const boxes = pivots.map((pivot) => {
    pivot.position.set(0, 0, 0);
    pivot.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(pivot);
  });
  const sizes = boxes.map((box) => (box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())));
  const total = sizes.reduce((sum, size) => sum + size.x, 0) + gap * (pivots.length - 1);

  let cursor = -total / 2;
  pivots.forEach((pivot, i) => {
    const box = boxes[i];
    if (box.isEmpty()) {
      cursor += gap;
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    pivot.position.set(cursor + sizes[i].x / 2 - center.x, -box.min.y, -center.z);
    pivot.updateMatrixWorld(true);
    cursor += sizes[i].x + gap;
  });
}

/** Drops a model back to the origin at its fit scale. */
export function resetTransform(pivot: THREE.Object3D, normalize: boolean) {
  pivot.position.set(0, 0, 0);
  pivot.quaternion.identity();
  pivot.userData.omniMoved = false;
  applyFitScale(pivot, normalize);
}

function hasHiddenAncestor(node: THREE.Object3D, root: THREE.Object3D) {
  for (let current: THREE.Object3D | null = node; current && current !== root; current = current.parent) {
    if (!current.visible) return true;
  }
  return false;
}

export interface StagedExport {
  /** Meshes that survived the visibility prune — zero means nothing to write. */
  meshes: number;
  /** Puts every detached node and every stashed userData key back. */
  restore: () => void;
}

/**
 * Prepares the live scene graph so an export carries exactly the geometry the
 * viewport is showing: hidden subtrees are detached, viewport-only userData is
 * stashed, and `restore()` undoes both.
 *
 * Detaching is what makes hiding work at all for OBJ and STL (their exporters
 * ignore `visible` entirely), and it keeps the glTF path honest for nodes whose
 * parent is hidden. Bones that still drive a surviving skinned mesh are kept
 * even when hidden — dropping them would leave the skin without joints — so the
 * caller must export with `includeHidden`.
 */
export function stageExport(source: THREE.Object3D): StagedExport {
  const keep = new Set<THREE.Object3D>();
  source.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton || hasHiddenAncestor(mesh, source)) return;
    for (const bone of mesh.skeleton.bones) {
      for (let node: THREE.Object3D | null = bone; node && node !== source; node = node.parent) keep.add(node);
    }
  });

  const detached: { node: THREE.Object3D; parent: THREE.Object3D; index: number }[] = [];
  const prune = (node: THREE.Object3D) => {
    for (const child of [...node.children]) {
      if (!child.visible && !keep.has(child)) {
        detached.push({ node: child, parent: node, index: node.children.indexOf(child) });
        child.removeFromParent();
        continue;
      }
      prune(child);
    }
  };
  prune(source);

  const stashed: { node: THREE.Object3D; data: Record<string, unknown> }[] = [];
  let meshes = 0;
  source.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) meshes++;
    const data: Record<string, unknown> = {};
    for (const key of INTERNAL_KEYS) {
      if (!(key in node.userData)) continue;
      data[key] = node.userData[key];
      delete node.userData[key];
    }
    if (Object.keys(data).length > 0) stashed.push({ node, data });
  });

  return {
    meshes,
    restore: () => {
      for (const { node, data } of stashed) Object.assign(node.userData, data);
      // Re-inserted at their original index so the node inspector keeps its order.
      for (let i = detached.length - 1; i >= 0; i--) {
        const { node, parent, index } = detached[i];
        parent.add(node);
        parent.children.pop();
        parent.children.splice(Math.min(index, parent.children.length), 0, node);
      }
    },
  };
}
