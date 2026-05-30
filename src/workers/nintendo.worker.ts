import { extractSZS, parseMDL0, decodeTEX0, createBMP } from "@/lib/nintendo/wii-parser";

/**
 * Nintendo Format Worker
 * Offloads heavy Yaz0 decompression, recursive archive extraction, and MDL0 parsing.
 */

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, requestId } = e.data;

  if (type === 'EXTRACT_SZS') {
    try {
      const { buffer, fileName } = payload;
      console.log(`[Worker] 📦 Starting extraction for: ${fileName} (${buffer.byteLength} bytes)`);
      
      const files = extractSZS(buffer);
      const decodedFiles: Record<string, Uint8Array> = {};
      const transferables: ArrayBuffer[] = [];

      Object.entries(files).forEach(([name, data]) => {
          if (name.endsWith('.tex0')) {
              try {
                  const result = decodeTEX0(data);
                  if (result) {
                      const bmp = createBMP(result.rgba, result.width, result.height);
                      decodedFiles[name.replace('.tex0', '.bmp')] = bmp;
                      transferables.push(bmp.buffer);
                      return;
                  }
              } catch (e) {
                  console.warn(`[Worker] Failed to decode TEX0: ${name}`, e);
              }
          }
          decodedFiles[name] = data;
          transferables.push(data.buffer);
      });

      console.log(`[Worker] ✅ Extraction complete: ${Object.keys(decodedFiles).length} files found`);
      self.postMessage({ type: 'EXTRACT_SUCCESS', requestId, payload: { files: decodedFiles, fileName } }, transferables);
    } catch (error: any) {
      console.error(`[Worker] ❌ Extraction error:`, error);
      self.postMessage({ type: 'EXTRACT_ERROR', requestId, payload: { error: error.message, fileName: payload.fileName } });
    }
  }

  if (type === 'PARSE_MDL0') {
    try {
      const { buffer, name } = payload;
      const requestId = e.data.requestId;
      console.log(`[Worker] 📐 Parsing MDL0: ${name} (${buffer.byteLength} bytes)`);
      
      const modelData = parseMDL0(buffer, name);
      console.log(`[Worker] ✅ MDL0 parsed: ${modelData.nodes.length} nodes`);

      modelData.nodes.forEach((node, i) => {
          const geo = modelData.geometries[node.geometryIdx];
          console.log(`[Worker]   Node ${i}: ${node.name} (${geo?.attributes.position.length / 3} vertices)`);
      });
      
      // Collect all transferable buffers
      const transferables: ArrayBuffer[] = [];
      modelData.geometries.forEach(geo => {
          if (geo.attributes.position) transferables.push(geo.attributes.position.buffer);
          if (geo.attributes.uv) transferables.push(geo.attributes.uv.buffer);
          if (geo.attributes.normal) transferables.push(geo.attributes.normal.buffer);
          if (geo.attributes.color) transferables.push(geo.attributes.color.buffer);
          if (geo.indices) transferables.push(geo.indices.buffer);
      });

      self.postMessage({ type: 'PARSE_MDL0_SUCCESS', requestId, payload: { modelData, name } }, transferables);
    } catch (error: any) {
      console.error(`[Worker] ❌ MDL0 Parse error:`, error);
      self.postMessage({ type: 'PARSE_MDL0_ERROR', requestId, payload: { error: error.message, name: payload.name } });
    }
  }
};
