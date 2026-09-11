import * as THREE from "three";

/** filename / path / basename -> blob url */
export type TextureMap = Record<string, string>;

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|tga|dds|bmp)$/i;

export function isTextureFile(fileName: string) {
  return IMAGE_EXT_RE.test(fileName);
}

export function imageMimeFor(ext: string) {
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/**
 * Resolves texture references coming out of DAE/GLTF/OBJ files against the
 * blob URLs extracted from the archive. Handles URL-encoding, relative paths,
 * and the Wii "_fix" eye textures that otherwise produce the Cyclops bug.
 */
export function createTextureResolver(textures: TextureMap, modelPath = "") {
  return (url: string): string => {
    if (url.startsWith("data:")) return url;
    let searchUrl = url;
    if (url.startsWith("blob:")) {
      if (IMAGE_EXT_RE.test(url)) {
        searchUrl = url.split("/").pop()?.split("?")[0] || url;
      } else return url;
    }
    const fileName = searchUrl.split("/").pop()?.split("?")[0] || "";
    const baseName = fileName.replace(/\.[^/.]+$/, "");
    const decodedFileName = decodeURIComponent(fileName);
    const decodedBaseName = decodeURIComponent(baseName);
    const normalized = searchUrl.replace(/\\/g, "/").replace(/^\.\//, "");

    // SURGICAL: Prefer _fix textures for eyes to resolve the Cyclops issue
    if (fileName.toLowerCase().includes("eye") || decodedFileName.toLowerCase().includes("eye")) {
      const fixBase = (baseName + "_fix").toLowerCase();
      const dFixBase = (decodedBaseName + "_fix").toLowerCase();
      const fixMatch = Object.keys(textures).find((k) => {
        const kFile = k.split("/").pop()?.replace(/\.[^/.]+$/, "").toLowerCase() || "";
        return kFile === fixBase || kFile === dFixBase;
      });
      if (fixMatch) return textures[fixMatch];
    }

    const direct =
      textures[normalized] ??
      textures[decodeURIComponent(normalized)] ??
      textures[fileName] ??
      textures[decodedFileName] ??
      textures[baseName] ??
      textures[decodedBaseName];
    if (direct) return direct;

    if (modelPath.includes("/")) {
      const modelDir = modelPath.substring(0, modelPath.lastIndexOf("/"));
      const relative = textures[`${modelDir}/${normalized}`] ?? textures[`${modelDir}/${fileName}`];
      if (relative) return relative;
    }

    const anyMatch = Object.keys(textures).find(
      (k) => k.endsWith("/" + fileName) || k === fileName || k.endsWith("/" + decodedFileName) || k === decodedFileName
    );
    return anyMatch ? textures[anyMatch] : url;
  };
}

/**
 * True when a geometry's UVs leave the 0-1 square, meaning the mesh picks its
 * region of an atlas by tiling and therefore needs real wrapping. 3DS face
 * atlases do exactly this (V runs past 2), so clamping them collapses the whole
 * face to a single smeared row of texels. Cached per geometry.
 */
function uvsTile(geometry: any): boolean {
  if (!geometry) return false;
  if (geometry.userData.omniUvTiles !== undefined) return geometry.userData.omniUvTiles;
  const uv = geometry.getAttribute?.("uv");
  let tiles = false;
  if (uv) {
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (u < 0 || u > 1 || v < 0 || v > 1) { tiles = true; break; }
    }
  }
  geometry.userData.omniUvTiles = tiles;
  return tiles;
}

type AlphaKind = "opaque" | "binary" | "graded";

const alphaKindCache = new WeakMap<object, AlphaKind>();

/**
 * Classifies a decoded texture's alpha channel so a material can pick the
 * cheapest blending mode that is still correct.
 *
 * This matters most on export: glTF carries only alphaMode, and a material
 * marked transparent becomes BLEND, which does not write depth. A fully opaque
 * face decal exported as BLEND turns see-through and flickers as the camera
 * moves in any viewer that sorts differently to ours — Blender included. Ripped
 * console decals are almost always fully opaque or hard-edged cutouts, so they
 * belong in OPAQUE or MASK. Returns "opaque" when the image cannot be read,
 * which is the safe default. Cached per image.
 */
function textureAlphaKind(texture: any): AlphaKind {
  const image = texture?.image;
  if (!image) return "opaque";
  const cached = alphaKindCache.get(image);
  if (cached) return cached;

  const width = image.naturalWidth ?? image.width ?? 0;
  const height = image.naturalHeight ?? image.height ?? 0;
  if (!width || !height) return "opaque";

  let kind: AlphaKind = "opaque";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "opaque";
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const pixels = width * height;
    // Very large atlases are sampled rather than scanned exhaustively.
    const step = Math.max(1, Math.floor(pixels / 1_000_000));
    for (let p = 0; p < pixels; p += step) {
      const alpha = data[p * 4 + 3];
      if (alpha === 255) continue;
      if (alpha === 0) { kind = "binary"; continue; }
      kind = "graded";
      break;
    }
  } catch {
    // A tainted or undecodable image cannot be classified; treat it as opaque.
    return "opaque";
  }

  alphaKindCache.set(image, kind);
  return kind;
}

/**
 * Texture V-origin by source format. glTF and the console parsers author UVs
 * with a top-left origin, so their maps must not be flipped; COLLADA, OBJ and
 * FBX follow the OpenGL bottom-left convention that TextureLoader assumes.
 * Getting this wrong mirrors every atlas vertically, which is why 3DS DAE rips
 * used to come out with the face and body regions swapped.
 */
export function flipYForModel(path: string) {
  const ext = path.toLowerCase().split(".").pop() || "";
  return !(ext === "glb" || ext === "gltf" || ext === "mdl0");
}

const SEMANTIC_TAGS = ["eye", "hair", "glass", "skin", "wood", "metal", "cloth", "face", "mouth", "tire", "wheel", "all", "body"];

/**
 * Assigns any texture the loader could not resolve on its own (weighted match
 * on material/mesh/Wii texture names) and applies the transparency,
 * render-order and wrap-mode heuristics that keep Wii-era models correct.
 */
export function applyMaterialFixes(
  model: THREE.Object3D,
  textures: TextureMap,
  textureLoader: THREE.TextureLoader,
  options: { flipY?: boolean } = {}
) {
  const sortedTextureKeys = Object.keys(textures).sort((a, b) => b.length - a.length);

  model.traverse((child: any) => {
    if (!child.isMesh) return;
    // Always repair the authored materials, even while an unlit or preview copy
    // is being displayed; the copy is rebuilt from them afterwards.
    const source = child.userData.omniOriginalMaterial || child.material;
    const mats = Array.isArray(source) ? source : [source];
    delete child.userData.omniUnlitMaterial;

    mats.forEach((mat: any) => {
      if (!mat) return;
      const matName = String(mat.name || "").toLowerCase();
      const meshName = String(child.name || "").toLowerCase();
      const wiiTexName = String(mat.userData.wiiTextureName || "").toLowerCase();

      // 1. UNIVERSAL WEIGHTED MATCHER
      if (!mat.map) {
        let bestKey = "";
        let bestScore = -1;
        const wiiTextures = (mat.userData.wiiTextures || []) as string[];

        for (const key of sortedTextureKeys) {
          const texFileName = key.toLowerCase().split("/").pop() || "";
          const texBaseName = texFileName.replace(/\.[^/.]+$/, "");
          let score = 0;

          // NINTENDO PRIORITY: Exact match on any of the material's texture slots
          if (wiiTexName && (texBaseName === wiiTexName || texFileName === wiiTexName)) score += 5000;
          for (const wTex of wiiTextures) {
            const wTexLower = wTex.toLowerCase();
            if (texBaseName === wTexLower || texFileName === wTexLower) {
              score += 4500; // Slightly lower than primary slot but still very high
              break;
            }
          }

          if (texBaseName === matName) score += 1000;
          if (matName.includes(texBaseName)) score += 500;
          if (texBaseName.includes(matName)) score += 400;

          for (const tag of SEMANTIC_TAGS) {
            const hasMatTag = matName.includes(tag) || meshName.includes(tag);
            const hasTexTag = texBaseName.includes(tag);
            if (hasMatTag && hasTexTag) score += 300;
            if (!hasMatTag && hasTexTag) score -= 800;
          }

          if (score > bestScore) {
            bestScore = score;
            bestKey = key;
          }
        }

        if (bestKey && bestScore > 0) mat.map = textureLoader.load(textures[bestKey]);
      }

      // 2. UNIVERSAL MATERIAL HEURISTICS
      if (!mat.map) return;

      mat.color.set(0xffffff);
      mat.opacity = 1.0;
      if (mat.emissive) mat.emissive.set(0x000000);
      if (mat.specular) mat.specular.set(0x000000);

      // Generic Semantic Layers + Surgical Targeting (polygon0/polygon1)
      const isEye = meshName === "polygon1" || matName.includes("eye") || meshName.includes("eye");
      const isMouth = matName.includes("mouth") || meshName.includes("mouth") || matName.includes("lm_");
      const isMustache = matName.includes("mustache") || meshName.includes("mustache");
      const isOverlay = isEye || isMouth || isMustache || matName.includes("alpha") || matName.includes("overlay");

      // Being an overlay decides where the decal sits, not how it blends — that
      // follows the texture's own alpha, so a decal with nothing to blend stays
      // opaque and keeps writing depth.
      const alphaKind = textureAlphaKind(mat.map);
      const blended = isOverlay && alphaKind === "graded";
      const cutout = isOverlay && alphaKind === "binary";

      mat.vertexColors = false;
      mat.transparent = blended;
      mat.alphaTest = cutout ? 0.5 : 0;

      if (isOverlay) {
        // Decals sit flush against the head. The polygon offset is what
        // actually wins the depth test; drawing them after the face is a cheap
        // belt-and-braces for anywhere the offset is unavailable or too small.
        // Both are viewport-only — glTF carries neither, which is why an
        // exported decal has to stay opaque rather than lean on draw order.
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -2;
        mat.polygonOffsetUnits = -8;
        child.renderOrder = isEye ? 50 : isMouth ? 10 : 20;
      } else {
        mat.polygonOffset = false;
        child.renderOrder = 0;
      }

      mat.side = THREE.DoubleSide;
      mat.depthWrite = !blended;
      mat.depthTest = true;

      // NINTENDO WRAP MODES
      if (mat.userData.wrapS !== undefined) {
        mat.map.wrapS = mat.userData.wrapS;
        mat.map.wrapT = mat.userData.wrapT;
      } else {
        // Eye atlases are clamped to stop neighbouring texels bleeding in, but
        // only when the UVs stay inside the unit square — a mesh that indexes
        // its atlas by tiling must keep wrapping or it loses the whole region.
        const clampEye = isEye && !uvsTile(child.geometry);
        mat.map.wrapS = mat.map.wrapT = clampEye ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      }

      // Console parsers emit top-left UVs regardless of the container they
      // came from; everything else follows the caller's per-format convention.
      const isConsoleMat = mat.userData.wiiTextureName !== undefined;
      mat.map.flipY = isConsoleMat ? false : (options.flipY ?? false);
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.minFilter = mat.map.magFilter = THREE.LinearFilter;
      mat.map.needsUpdate = true;
      mat.needsUpdate = true;
    });
  });
}

export type DisplayMode = "shaded" | "wireframe" | "normals" | "uv";

let uvCheckerTexture: THREE.Texture | null = null;

/** Procedural UV checker board used by the "UV" display mode. */
function getUvChecker(): THREE.Texture {
  if (uvCheckerTexture) return uvCheckerTexture;
  const size = 512;
  const cells = 8;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const step = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#e11d48" : "#1f2228";
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  uvCheckerTexture = new THREE.CanvasTexture(canvas);
  uvCheckerTexture.wrapS = uvCheckerTexture.wrapT = THREE.RepeatWrapping;
  uvCheckerTexture.colorSpace = THREE.SRGBColorSpace;
  return uvCheckerTexture;
}

/**
 * Console models (and most game assets) ship with lighting already baked into
 * the texture, so shading them again darkens and desaturates every surface.
 * An unlit copy displays the authored colours exactly, tone mapping included.
 */
function toUnlit(source: THREE.Material): THREE.Material {
  const mat = source as any;
  const unlit = new THREE.MeshBasicMaterial({
    map: mat.map ?? null,
    transparent: !!mat.transparent,
    opacity: mat.opacity ?? 1,
    alphaTest: mat.alphaTest ?? 0,
    side: mat.side ?? THREE.FrontSide,
    depthWrite: mat.depthWrite ?? true,
    depthTest: mat.depthTest ?? true,
    name: mat.name,
  });
  if (mat.color) unlit.color.copy(mat.color);
  unlit.polygonOffset = !!mat.polygonOffset;
  unlit.polygonOffsetFactor = mat.polygonOffsetFactor ?? 0;
  unlit.polygonOffsetUnits = mat.polygonOffsetUnits ?? 0;
  // Skip tone mapping so texels reach the screen as authored.
  unlit.toneMapped = false;
  return unlit;
}

/** True when a subtree came out of a console parser (MDL0 and friends). */
export function isConsoleModel(root: THREE.Object3D) {
  let found = false;
  root.traverse((child: any) => {
    if (found || !child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    if (mats.some((m: any) => m?.userData?.wiiTextureName !== undefined)) found = true;
  });
  return found;
}

/**
 * Swaps meshes between shaded, wireframe, normal and UV-checker views. The
 * authored materials are parked in userData so the change is reversible.
 */
export function applyDisplayMode(root: THREE.Object3D, mode: DisplayMode, unlit = false) {
  root.traverse((child: any) => {
    if (!child.isMesh) return;
    if (!child.userData.omniOriginalMaterial) child.userData.omniOriginalMaterial = child.material;
    const original = child.userData.omniOriginalMaterial;

    if (mode === "shaded" || mode === "wireframe") {
      if (unlit) {
        if (!child.userData.omniUnlitMaterial) {
          child.userData.omniUnlitMaterial = Array.isArray(original)
            ? original.map((m: THREE.Material) => (m ? toUnlit(m) : m))
            : toUnlit(original);
        }
        child.material = child.userData.omniUnlitMaterial;
      } else {
        child.material = original;
      }
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat: any) => { if (mat) mat.wireframe = mode === "wireframe"; });
      return;
    }

    if (mode === "normals") {
      if (!child.userData.omniNormalMaterial) child.userData.omniNormalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
      child.material = child.userData.omniNormalMaterial;
      return;
    }

    if (!child.userData.omniUvMaterial) {
      child.userData.omniUvMaterial = new THREE.MeshBasicMaterial({ map: getUvChecker(), side: THREE.DoubleSide });
    }
    child.material = child.userData.omniUvMaterial;
  });
}

export interface SceneStats {
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
}

/** Counts geometry and material usage across a subtree. */
export function collectStats(root: THREE.Object3D): SceneStats {
  const materials = new Set<unknown>();
  const textures = new Set<unknown>();
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;

  root.traverse((child: any) => {
    if (!child.isMesh || !child.geometry) return;
    meshes++;
    const geometry = child.geometry;
    const position = geometry.getAttribute?.("position");
    if (position) vertices += position.count;
    triangles += geometry.index ? geometry.index.count / 3 : (position?.count || 0) / 3;

    const mats = Array.isArray(child.userData.omniOriginalMaterial || child.material)
      ? (child.userData.omniOriginalMaterial || child.material)
      : [child.userData.omniOriginalMaterial || child.material];
    for (const mat of mats) {
      if (!mat) continue;
      materials.add(mat);
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && typeof value === "object" && "isTexture" in value) textures.add(value);
      }
    }
  });

  return { meshes, triangles: Math.round(triangles), vertices, materials: materials.size, textures: textures.size };
}

/** Frees every GPU resource held by a subtree. */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((child: any) => {
    if (child.isMesh) {
      child.geometry?.dispose?.();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat: any) => {
        if (!mat) return;
        for (const key of Object.keys(mat)) {
          const value = mat[key];
          if (value && typeof value === "object" && "isTexture" in value) (value as THREE.Texture).dispose();
        }
        mat.dispose?.();
      });
    }
  });
}
