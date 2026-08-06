/**
 * GLB post-processing: texture downscaling and Meshopt geometry compression.
 *
 * Runs on the exported binary rather than the live scene, so the viewport is
 * never disturbed. Every step is best-effort — if a transform fails the
 * original GLB is returned untouched.
 */

export interface OptimizeOptions {
  /** Longest texture edge in pixels; larger images are resampled down. */
  maxTextureSize?: number;
  /** Apply EXT_meshopt_compression to geometry. */
  compress?: boolean;
}

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };

async function resizeTextures(doc: any, maxSize: number) {
  for (const texture of doc.getRoot().listTextures()) {
    const image: Uint8Array | null = texture.getImage();
    const mimeType: string = texture.getMimeType() || MIME_BY_EXT[texture.getURI?.()?.split(".").pop() || ""] || "image/png";
    if (!image || !mimeType.startsWith("image/")) continue;

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([image as BlobPart], { type: mimeType }));
    } catch {
      continue; // unsupported codec (KTX2, DDS); leave it alone
    }

    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxSize) {
      bitmap.close();
      continue;
    }

    const scale = maxSize / longest;
    const target = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const ctx = target.getContext("2d");
    if (!ctx) {
      bitmap.close();
      continue;
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close();

    const outputMime = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await target.convertToBlob({ type: outputMime, quality: 0.92 });
    texture.setImage(new Uint8Array(await blob.arrayBuffer()));
    texture.setMimeType(outputMime);
  }
}

/** Rewrites a GLB with the requested optimisations applied. */
export async function optimizeGlb(glb: ArrayBuffer, options: OptimizeOptions = {}): Promise<ArrayBuffer> {
  const { maxTextureSize, compress } = options;
  if (!maxTextureSize && !compress) return glb;

  try {
    const [{ WebIO }, extensions, functions] = await Promise.all([
      import("@gltf-transform/core"),
      import("@gltf-transform/extensions"),
      import("@gltf-transform/functions"),
    ]);

    const io = new WebIO().registerExtensions(extensions.ALL_EXTENSIONS as never);
    const document = await io.readBinary(new Uint8Array(glb));

    const transforms: unknown[] = [functions.dedup()];
    if (compress) {
      const { MeshoptEncoder } = await import("meshoptimizer");
      await MeshoptEncoder.ready;
      io.registerDependencies({ "meshopt.encoder": MeshoptEncoder });
      transforms.push(functions.meshopt({ encoder: MeshoptEncoder, level: "high" }));
    }

    if (maxTextureSize) await resizeTextures(document, maxTextureSize);
    await document.transform(...(transforms as never[]));

    const output = await io.writeBinary(document);
    return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
  } catch (err) {
    console.warn("[3D] GLB optimisation skipped:", err);
    return glb;
  }
}

/** Meshopt-compressed models need a decoder registered on the loader. */
export async function getMeshoptDecoder() {
  try {
    const { MeshoptDecoder } = await import("meshoptimizer");
    await MeshoptDecoder.ready;
    return MeshoptDecoder;
  } catch {
    return null;
  }
}
