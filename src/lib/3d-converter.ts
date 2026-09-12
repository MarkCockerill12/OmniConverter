import type * as THREE_NS from "three";
import { unzipSync } from "fflate";
import { getExtension } from "./utils";
import type { TextureMap } from "./3d-materials";

/**
 * Headless 3D pipeline: archive discovery, in-memory loading and export.
 *
 * Everything here runs client-side. Three.js and its loaders are imported
 * lazily so the landing page never pays for the 3D engine until a model is
 * actually touched.
 */

const MODEL_EXTS = ["dae", "glb", "gltf", "obj", "stl", "fbx", "mdl0"];

export interface DiscoveredModel {
  /** Path inside the archive (or the plain file name). */
  path: string;
  name: string;
  file: File;
  textures: TextureMap;
  sourceName: string;
}

/** COLLADA 1.5 writes <init_from><ref>…</ref></init_from>, which three.js cannot read. */
function preprocessDAE(data: Uint8Array): Uint8Array {
  try {
    const content = new TextDecoder().decode(data);
    return new TextEncoder().encode(
      content.replace(/<init_from>\s*<ref>([\s\S]*?)<\/ref>\s*<\/init_from>/g, "<init_from>$1</init_from>")
    );
  } catch (e) {
    console.warn("[3D] DAE pre-process failed:", e);
    return data;
  }
}

async function extractSZSViaWorker(file: File, worker: Worker): Promise<Record<string, Uint8Array>> {
  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      if (e.data.payload?.fileName !== file.name) return;
      if (e.data.type === "EXTRACT_SUCCESS") {
        worker.removeEventListener("message", handler);
        resolve(e.data.payload.files);
      } else if (e.data.type === "EXTRACT_ERROR") {
        worker.removeEventListener("message", handler);
        reject(new Error(e.data.payload.error));
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: "EXTRACT_SZS", payload: { buffer, fileName: file.name } }, [buffer]);
  });
}

/**
 * Expands a file into the list of models it contains. ZIP archives are read
 * with fflate, Nintendo .szs containers are unpacked in the Nintendo worker,
 * and plain model files pass straight through.
 */
export async function discoverModels(
  file: File,
  options: { textures?: TextureMap; nintendoWorker?: Worker | null } = {}
): Promise<DiscoveredModel[]> {
  const { isTextureFile, imageMimeFor } = await import("./3d-materials");
  const ext = getExtension(file.name);
  const isZip = ext === "zip";
  const isSzs = ext === "szs";

  if (!isZip && !isSzs) {
    if (!MODEL_EXTS.includes(ext)) return [];
    return [
      {
        path: file.name,
        name: file.name,
        file,
        textures: options.textures || {},
        sourceName: file.name,
      },
    ];
  }

  let unpacked: Record<string, Uint8Array>;
  if (isZip) {
    unpacked = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } else if (options.nintendoWorker) {
    unpacked = await extractSZSViaWorker(file, options.nintendoWorker);
  } else {
    const { extractSZS } = await import("./nintendo/wii-parser");
    unpacked = extractSZS(await file.arrayBuffer());
  }

  const textures: TextureMap = { ...options.textures };
  const entries = Object.entries(unpacked);

  // Bare file-name and base-name keys are ambiguous: rips ship remastered copies
  // of a texture under the same name in a sub-folder ("Switch/MoonRabbitBody.png"
  // beside the Wii original). The deeper copy must not claim the short key, or a
  // model that asks for "MoonRabbitBody.png" gets the wrong console's atlas.
  const keyDepth = new Map<string, number>();
  for (const key of Object.keys(textures)) keyDepth.set(key, 0);
  const claimShortKey = (key: string, depth: number, url: string) => {
    const owner = keyDepth.get(key);
    if (owner !== undefined && owner <= depth) return;
    keyDepth.set(key, depth);
    textures[key] = url;
  };

  for (const [path, data] of entries) {
    if (data.length === 0 || !isTextureFile(path)) continue;
    const normalized = path.replace(/\\/g, "/");
    const filename = normalized.split("/").pop() || normalized;
    const depth = normalized.split("/").length;
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: imageMimeFor(getExtension(filename)) }));
    // Full paths are unique, so they are always safe to write.
    textures[normalized] = url;
    textures[path] = url;
    claimShortKey(filename, depth, url);
    claimShortKey(filename.replace(/\.[^/.]+$/, ""), depth, url);
  }

  const models: DiscoveredModel[] = [];
  for (const [path, data] of entries) {
    if (data.length === 0) continue;
    const entryExt = getExtension(path);
    if (!MODEL_EXTS.includes(entryExt)) continue;
    const payload = entryExt === "dae" ? preprocessDAE(data) : data;
    const normalized = path.replace(/\\/g, "/");
    models.push({
      path: normalized,
      name: normalized.split("/").pop() || normalized,
      file: new File([new Blob([payload as BlobPart])], normalized),
      textures,
      sourceName: file.name,
    });
  }
  return models;
}

/** Trailing markers a ripper adds to alternate copies of one subject. */
const LOD_MARKERS = ["lowpoly", "low", "middle", "mid", "high", "hi", "lod0", "lod1", "lod2", "lod3", "lod"];
const BAKE_MARKERS = ["baked", "bakes", "bake"];

/**
 * Removes one trailing marker, but only where it reads as a suffix rather than
 * as the tail of a word: after a separator ("MoonRabbit_low") or at a camel-case
 * boundary ("MoonRabbitLow"). "Pyramid" therefore keeps its "mid".
 */
function stripMarker(name: string, markers: string[]): string {
  const lower = name.toLowerCase();
  for (const marker of markers) {
    if (!lower.endsWith(marker)) continue;
    const head = name.slice(0, name.length - marker.length);
    if (!head) continue;
    if (/[_\-. ]$/.test(head)) return head.replace(/[_\-. ]+$/, "");
    if (/[a-z0-9]$/.test(head) && /^[A-Z]/.test(name.slice(head.length))) return head;
  }
  return name;
}

/**
 * Reduces a file name to the subject it depicts, so "MoonRabbit.dae",
 * "MoonRabbitLow.dae" and "MoonRabbit_bake.dae" share a stem. Only trailing
 * markers go — "TrickRabbit" keeps its own stem, because it is a different
 * character rather than another take on the same one.
 */
function variantStem(path: string): string {
  const name = (path.split("/").pop() || path).replace(/\.[^/.]+$/, "");
  let stem = name;
  for (let i = 0; i < 3; i++) {
    const stripped = stripMarker(stripMarker(stem, BAKE_MARKERS), LOD_MARKERS);
    if (stripped === stem) break;
    stem = stripped;
  }
  return (stem || name).toLowerCase();
}

/** True when the model is a ripper's vertex-colour bake of another model. */
function isBakeVariant(path: string): boolean {
  const name = (path.split("/").pop() || path).replace(/\.[^/.]+$/, "");
  return stripMarker(name, BAKE_MARKERS) !== name;
}

/**
 * Archives hold models in two shapes. A console container (.szs) splits one
 * subject across several MDL0 files that must be merged, so those pass through
 * untouched. Ripped ZIPs instead ship alternate copies of a subject — Models
 * Resource puts "Z-Powered" or "Other Bag" in a sibling folder, and stacks
 * "MoonRabbit", "MoonRabbitLow", "MoonRabbitMiddle" and a "_bake" twin of each
 * in one folder. Merging any of those puts several copies of the same character
 * at one origin, which reads as a model wearing two textures at once.
 *
 * Two passes narrow the archive down: the primary directory (shallowest, then
 * largest) wins, and within it each variant family collapses to its best member
 * — full detail over an LOD, the plain model over its vertex-colour bake. The
 * rest stay reachable from the Forge catalogue, which lists every model found.
 */
export function selectPrimaryModels(models: DiscoveredModel[]): DiscoveredModel[] {
  if (models.length < 2) return models;
  if (models.some((m) => getExtension(m.path) === "mdl0")) return models;

  const groups = new Map<string, DiscoveredModel[]>();
  for (const model of models) {
    const slash = model.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : model.path.slice(0, slash);
    const bucket = groups.get(dir);
    if (bucket) bucket.push(model);
    else groups.set(dir, [model]);
  }

  let best = models;
  if (groups.size > 1) {
    let bestDepth = Infinity;
    let bestSize = -Infinity;
    for (const [dir, bucket] of groups) {
      const depth = dir === "" ? 0 : dir.split("/").length;
      const size = bucket.reduce((total, m) => total + m.file.size, 0);
      if (depth < bestDepth || (depth === bestDepth && size > bestSize)) {
        bestDepth = depth;
        bestSize = size;
        best = bucket;
      }
    }
  }

  return collapseVariants(best);
}

/** Keeps one model per variant family: no bake twin, no LOD, largest wins. */
function collapseVariants(models: DiscoveredModel[]): DiscoveredModel[] {
  if (models.length < 2) return models;
  const families = new Map<string, DiscoveredModel>();
  const order: string[] = [];

  for (const model of models) {
    const stem = variantStem(model.path);
    const held = families.get(stem);
    if (!held) {
      families.set(stem, model);
      order.push(stem);
      continue;
    }
    const heldIsBake = isBakeVariant(held.path);
    const modelIsBake = isBakeVariant(model.path);
    if (heldIsBake !== modelIsBake) {
      if (heldIsBake) families.set(stem, model);
      continue;
    }
    // Same flavour: the biggest file is the most detailed copy.
    if (model.file.size > held.file.size) families.set(stem, model);
  }

  return order.map((stem) => families.get(stem)!);
}

/** Releases every blob URL created by {@link discoverModels}. */
export function revokeTextures(textures: TextureMap) {
  for (const url of new Set(Object.values(textures))) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

/**
 * Removes the vertex-colour copy a ripper bakes into "_bake" exports.
 *
 * Those files carry the subject twice: the textured mesh, plus an identical
 * copy ("m0_VC") whose only map is a greyscale bake of the vertex colours. The
 * two occupy the same coordinates, so the bake wins half the depth test and the
 * model renders as a grey, flickering shell of itself. The copy is only dropped
 * when a normally textured mesh survives it.
 */
function dropVertexColourBakeMeshes(root: THREE_NS.Object3D) {
  const isBakeMesh = (child: any) => {
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const named = (value: unknown) => String(value || "").toLowerCase().replace(/[\s_-]/g, "");
    return (
      mats.some((mat: any) => mat && named(mat.name) === "vertexcolors") ||
      /[_\-. ]vc$/i.test(String(child.name || ""))
    );
  };

  const bakes: any[] = [];
  let textured = 0;
  root.traverse((child: any) => {
    if (!child.isMesh) return;
    if (isBakeMesh(child)) bakes.push(child);
    else textured++;
  });
  if (!textured || !bakes.length) return;

  for (const mesh of bakes) {
    mesh.parent?.remove(mesh);
    mesh.geometry?.dispose?.();
  }
}

/** Fraction of space two boxes share, padded so flat models still compare. */
function boxOverlapRatio(a: THREE_NS.Box3, b: THREE_NS.Box3): number {
  const pad = 1e-4 * Math.max(a.max.x - a.min.x, a.max.y - a.min.y, a.max.z - a.min.z, 1);
  const volume = (box: THREE_NS.Box3) =>
    (box.max.x - box.min.x + pad) * (box.max.y - box.min.y + pad) * (box.max.z - box.min.z + pad);
  const span = (lo: number, hi: number) => Math.max(0, hi - lo) + pad;
  const inter =
    span(Math.max(a.min.x, b.min.x), Math.min(a.max.x, b.max.x)) *
    span(Math.max(a.min.y, b.min.y), Math.min(a.max.y, b.max.y)) *
    span(Math.max(a.min.z, b.min.z), Math.min(a.max.z, b.max.z));
  const union = volume(a) + volume(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Loads a single model file into a Three.js object. `manager` lets the caller
 * inject the texture resolver used for archive-relative image references.
 */
export async function loadModelObject(
  file: File,
  manager: THREE_NS.LoadingManager,
  nintendoWorker?: Worker | null
): Promise<THREE_NS.Object3D> {
  const THREE = await import("three");
  const ext = getExtension(file.name);
  const url = URL.createObjectURL(file);

  // GLB files are frequently mislabelled (e.g. renamed to .fbx) — sniff the magic.
  let isGLB = false;
  try {
    const view = new DataView(await file.slice(0, 4).arrayBuffer());
    isGLB = view.byteLength >= 4 && view.getUint32(0, false) === 0x676c5446;
  } catch {
    /* unreadable header, fall back to the extension */
  }

  try {
    const object = await new Promise<THREE_NS.Object3D>((resolve, reject) => {
      const fail = (err: unknown) => reject(err instanceof Error ? err : new Error(`Could not read ${file.name}`));

      if (isGLB || ext === "glb" || ext === "gltf") {
        import("three/examples/jsm/loaders/GLTFLoader.js").then(async ({ GLTFLoader }) => {
          const loader = new GLTFLoader(manager);
          // Models exported with Meshopt compression need their decoder.
          const { getMeshoptDecoder } = await import("./3d-optimize");
          const decoder = await getMeshoptDecoder();
          if (decoder) loader.setMeshoptDecoder(decoder as never);
          loader.load(url, (gltf) => {
            gltf.scene.userData.animations = gltf.animations;
            resolve(gltf.scene);
          }, undefined, fail);
        });
      } else if (ext === "fbx") {
        import("three/examples/jsm/loaders/FBXLoader.js").then(({ FBXLoader }) =>
          new FBXLoader(manager).load(url, (fbx) => {
            fbx.userData.animations = fbx.animations;
            resolve(fbx);
          }, undefined, fail)
        );
      } else if (ext === "dae") {
        import("three/examples/jsm/loaders/ColladaLoader.js").then(({ ColladaLoader }) => {
          const loader = new ColladaLoader(manager);
          if (file.name.includes("/")) loader.setResourcePath(file.name.substring(0, file.name.lastIndexOf("/") + 1));
          loader.load(url, (collada) => (collada ? resolve(collada.scene) : fail(null)), undefined, fail);
        });
      } else if (ext === "obj") {
        import("three/examples/jsm/loaders/OBJLoader.js").then(({ OBJLoader }) =>
          new OBJLoader(manager).load(url, resolve, undefined, fail)
        );
      } else if (ext === "stl") {
        import("three/examples/jsm/loaders/STLLoader.js").then(({ STLLoader }) =>
          new STLLoader(manager).load(
            url,
            (geometry) => resolve(new THREE.Mesh(geometry, new THREE.MeshPhongMaterial())),
            undefined,
            fail
          )
        );
      } else if (ext === "mdl0") {
        import("./nintendo/WiiLoader").then(({ WiiLoader }) =>
          new WiiLoader(manager, nintendoWorker).load(url, resolve, undefined, fail)
        );
      } else {
        fail(new Error(`Unsupported 3D format: .${ext.toUpperCase()}`));
      }
    });
    dropVertexColourBakeMeshes(object);
    return object;
  } finally {
    // Loaders read the blob synchronously during load(); revoke on the next tick.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * Waits until every texture referenced by the object has decoded.
 *
 * TextureLoader hands back a Texture whose `image` stays undefined until the
 * request finishes, so watching for an incomplete HTMLImageElement misses any
 * texture still in flight and the exporter then rejects it with "No valid image
 * data found". Polling the textures themselves covers both states, and every
 * slot is checked rather than just `map`. An image that fails to load still
 * reports `complete`, so a broken reference falls through to the deadline
 * instead of stalling the conversion.
 */
async function awaitTextures(object: THREE_NS.Object3D, timeoutMs = 15_000) {
  const textures = new Set<any>();
  object.traverse((child: any) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && typeof value === "object" && value.isTexture) textures.add(value);
      }
    }
  });
  if (textures.size === 0) return;

  const decoded = (texture: any) => {
    const image = texture.image;
    if (!image) return false;
    // Canvas and ImageBitmap sources carry their pixels immediately.
    return image instanceof HTMLImageElement ? image.complete : true;
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ([...textures].every(decoded)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface ExportOptions {
  /** Longest texture edge in the exported GLB. */
  maxTextureSize?: number;
  /** Apply Meshopt geometry compression (GLB only). */
  compress?: boolean;
}

/** Serialises a Three.js object to GLB, GLTF, OBJ or STL. */
export async function exportModel(
  object: THREE_NS.Object3D,
  format: string,
  options: ExportOptions = {}
): Promise<Blob> {
  const target = format.toLowerCase();

  if (target === "obj") {
    const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
    return new Blob([new OBJExporter().parse(object)], { type: "text/plain" });
  }

  if (target === "stl") {
    const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
    return new Blob([new STLExporter().parse(object, { binary: true }) as unknown as BlobPart], {
      type: "application/octet-stream",
    });
  }

  if (target === "glb" || target === "gltf") {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const binary = target === "glb";
    await awaitTextures(object);
    const result = await new GLTFExporter().parseAsync(object, { binary, includeCustomExtensions: true });

    if (binary && (options.maxTextureSize || options.compress)) {
      const { optimizeGlb } = await import("./3d-optimize");
      const optimised = await optimizeGlb(result as ArrayBuffer, options);
      return new Blob([optimised], { type: "model/gltf-binary" });
    }

    return new Blob([binary ? (result as ArrayBuffer) : JSON.stringify(result)], {
      type: binary ? "model/gltf-binary" : "application/json",
    });
  }

  throw new Error(`${format.toUpperCase()} is not supported as an export target.`);
}

/**
 * Full file-to-file conversion. Archives (.zip/.szs) are unpacked, every model
 * inside is merged into one scene with its textures resolved, and the result is
 * exported in the requested format.
 */
export async function convert3DModelHeadless(
  file: File,
  targetFormat: string,
  nintendoWorker?: Worker | null
): Promise<Blob> {
  const THREE = await import("three");
  const { createTextureResolver, applyMaterialFixes, disposeObject, flipYForModel } = await import("./3d-materials");

  const found = await discoverModels(file, { nintendoWorker });
  if (found.length === 0) {
    throw new Error(`No 3D model found in ${file.name}.`);
  }
  const discovered = selectPrimaryModels(found);

  const root = new THREE.Group();
  const textures = found[0].textures;
  // Plain model files keep their authored materials untouched; archives go
  // through the repair pipeline so their loose textures get re-attached.
  const needsRepair = Object.keys(textures).length > 0;
  // A console container splits one subject across several files that belong
  // together; a ripped archive can still hold copies the name rules miss, and
  // those sit on top of the model already added. Space decides between them.
  const checkOverlap = discovered.length > 1 && !discovered.some((m) => getExtension(m.path) === "mdl0");
  const placed: THREE_NS.Box3[] = [];

  for (const model of discovered) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(createTextureResolver(model.textures, model.path));
    const object = await loadModelObject(model.file, manager, nintendoWorker);
    if (checkOverlap) {
      const box = new THREE.Box3().setFromObject(object);
      if (!box.isEmpty()) {
        if (placed.some((other) => boxOverlapRatio(other, box) >= 0.6)) {
          disposeObject(object);
          continue;
        }
        placed.push(box);
      }
    }
    if (needsRepair) {
      const textureLoader = new THREE.TextureLoader(manager);
      const flipY = flipYForModel(model.path);
      applyMaterialFixes(object, model.textures, textureLoader, { flipY });
      // Classifying a texture's alpha needs its pixels, and the loaders resolve
      // before their images decode. The viewport gets this from the manager's
      // onLoad; here a second pass over settled textures does the same job.
      await awaitTextures(object);
      applyMaterialFixes(object, model.textures, textureLoader, { flipY });
    }
    root.add(object);
  }

  try {
    return await exportModel(root, targetFormat);
  } finally {
    disposeObject(root);
    revokeTextures(textures);
  }
}
