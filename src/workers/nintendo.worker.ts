import { extractSZS, parseMDL0, decodeTEX0, createPNG } from "@/lib/nintendo/wii-parser";

/**
 * Nintendo Format Worker
 * Offloads heavy Yaz0 decompression, recursive archive extraction, and MDL0 parsing.
 */

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, requestId } = e.data;

  if (type === 'EXTRACT_SZS') {
    try {
      const { buffer, fileName } = payload;
      console.log(`[Worker] 📦 Starting extraction for: ${fileName}`);
      
      const files = extractSZS(buffer);
      const decodedFiles: Record<string, Uint8Array> = {};
      const transferables: ArrayBuffer[] = [];

      Object.entries(files).forEach(([name, data]) => {
          if (name.endsWith('.tex0')) {
              try {
                  const result = decodeTEX0(data);
                  if (result) {
                      const png = createPNG(result.rgba, result.width, result.height);
                      decodedFiles[name.replace('.tex0', '.png')] = png;
                      transferables.push(png.buffer as ArrayBuffer);
                      return;
                  }
              } catch (decodeError) {
                  console.warn(`[Worker] Failed to decode TEX0: ${name}`, decodeError);
              }
          }
          decodedFiles[name] = data;
          transferables.push(data.buffer as ArrayBuffer);
      });

      self.postMessage({ type: 'EXTRACT_SUCCESS', requestId, payload: { files: decodedFiles, fileName } }, transferables);
    } catch (error: any) {
      console.error(`[Worker] ❌ Extraction error:`, error);
      self.postMessage({ type: 'EXTRACT_ERROR', requestId, payload: { error: error.message, fileName: payload.fileName } });
    }
  }

  if (type === 'PARSE_MDL0') {
    try {
      const { buffer, name } = payload;
      const modelData = parseMDL0(buffer, name);
      
      const matSummary = modelData.materials.map(m => `${m.name} (${m.textures.join(', ') || 'no tex'})`).join(' | ');
      console.log(`[Worker] 📦 Parsed MDL0: ${name} | Materials: ${matSummary}`);

      const transferables: ArrayBuffer[] = [];
      modelData.geometries.forEach(geo => {
          if (geo.attributes.position) transferables.push(geo.attributes.position.buffer as ArrayBuffer);
          if (geo.attributes.normal) transferables.push(geo.attributes.normal.buffer as ArrayBuffer);
          if (geo.attributes.uv) transferables.push(geo.attributes.uv.buffer as ArrayBuffer);
          if (geo.indices) transferables.push(geo.indices.buffer as ArrayBuffer);
      });

      self.postMessage({ type: 'PARSE_MDL0_SUCCESS', requestId, payload: { modelData, name } }, transferables);
    } catch (error: any) {
      console.error(`[Worker] ❌ MDL0 Parse error:`, error);
      self.postMessage({ type: 'PARSE_MDL0_ERROR', requestId, payload: { error: error.message, name: payload.name } });
    }
  }
};
