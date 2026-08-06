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

  for (const [path, data] of entries) {
    if (data.length === 0 || !isTextureFile(path)) continue;
    const normalized = path.replace(/\\/g, "/");
    const filename = normalized.split("/").pop() || normalized;
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: imageMimeFor(getExtension(filename)) }));
    textures[normalized] = url;
    textures[filename] = url;
    textures[path] = url;
    textures[filename.replace(/\.[^/.]+$/, "")] = url;
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

/** Releases every blob URL created by {@link discoverModels}. */
export function revokeTextures(textures: TextureMap) {
  for (const url of new Set(Object.values(textures))) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
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
    return await new Promise<THREE_NS.Object3D>((resolve, reject) => {
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
  } finally {
    // Loaders read the blob synchronously during load(); revoke on the next tick.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Waits until every image referenced by the object has finished decoding. */
async function awaitTextures(object: THREE_NS.Object3D) {
  const pending: Promise<unknown>[] = [];
  object.traverse((child: any) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      const image = mat?.map?.image;
      if (image instanceof HTMLImageElement && !image.complete) {
        pending.push(new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        }));
      }
    }
  });
  if (pending.length) await Promise.all(pending);
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
  const { createTextureResolver, applyMaterialFixes, disposeObject } = await import("./3d-materials");

  const discovered = await discoverModels(file, { nintendoWorker });
  if (discovered.length === 0) {
    throw new Error(`No 3D model found in ${file.name}.`);
  }

  const root = new THREE.Group();
  const textures = discovered[0].textures;
  // Plain model files keep their authored materials untouched; archives go
  // through the repair pipeline so their loose textures get re-attached.
  const needsRepair = Object.keys(textures).length > 0;

  for (const model of discovered) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(createTextureResolver(model.textures, model.path));
    const object = await loadModelObject(model.file, manager, nintendoWorker);
    if (needsRepair) applyMaterialFixes(object, model.textures, new THREE.TextureLoader(manager));
    root.add(object);
  }

  try {
    return await exportModel(root, targetFormat);
  } finally {
    disposeObject(root);
    revokeTextures(textures);
  }
}
