/**
 * Wii Format Parser
 * High-performance binary decoder for Nintendo Wii models.
 * Reverse-engineered from BrawlLib/BrawlCrate logic.
 */

export function decompressYaz0(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 16 || view.getUint32(0) !== 0x59617A30) return data;
  const uncompressedSize = view.getUint32(4);
  const output = new Uint8Array(uncompressedSize);
  let srcPos = 16, dstPos = 0, codeByte = 0, bitCount = 0;
  while (dstPos < uncompressedSize && srcPos < data.length) {
    if (bitCount === 0) { codeByte = data[srcPos++]; bitCount = 8; }
    if (codeByte & 0x80) { output[dstPos++] = data[srcPos++]; } else {
      const b1 = data[srcPos++], b2 = data[srcPos++];
      const dist = ((b1 & 0x0F) << 8 | b2) + 1;
      let count = b1 >> 4;
      if (count === 0) { count = data[srcPos++] + 0x12; } else count += 2;
      let copySrc = dstPos - dist;
      for (let i = 0; i < count; i++) { if (dstPos >= uncompressedSize) break; output[dstPos++] = output[copySrc++]; }
    }
    codeByte = (codeByte << 1) & 0xFF; bitCount--;
  }
  return output;
}

export function parseU8(data: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 0x20 || view.getUint32(0) !== 0x55AA382D) return {};
  const nodesCount = view.getUint32(12);
  const rootNodeOffset = view.getUint32(4);
  const nodes = view.getUint32(rootNodeOffset + 8);
  const stringTableOffset = rootNodeOffset + (nodes * 12);
  const files: Record<string, Uint8Array> = {};
  const pathStack: string[] = [];
  const nodeEndStack: number[] = [nodes];
  const decoder = new TextDecoder();
  for (let i = 0; i < nodes; i++) {
    const entryOffset = rootNodeOffset + (i * 12);
    const type = view.getUint8(entryOffset);
    const nameOffset = view.getUint32(entryOffset) & 0x00FFFFFF;
    let nameEnd = stringTableOffset + nameOffset;
    while (nameEnd < data.length && data[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(data.slice(stringTableOffset + nameOffset, nameEnd));
    while (pathStack.length > 0 && i >= nodeEndStack[nodeEndStack.length - 1]) { pathStack.pop(); nodeEndStack.pop(); }
    if (type === 0x01) { if (name !== "" && name !== ".") { pathStack.push(name); nodeEndStack.push(view.getUint32(entryOffset + 8)); } }
    else {
      const fileOffset = view.getUint32(entryOffset + 4);
      const fileSize = view.getUint32(entryOffset + 8);
      const fullPath = pathStack.length > 0 ? pathStack.join('/') + '/' + name : name;
      files[fullPath] = data.slice(fileOffset, fileOffset + fileSize);
    }
  }
  return files;
}

export function parseBRRES(data: Uint8Array): Record<string, Uint8Array> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== 0x62726573) return {};
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < data.length - 8; i += 4) {
        const magic = view.getUint32(i);
        if (magic === 0x4D444C30) {
            const size = view.getUint32(i + 4);
            if (size > 64 && i + size <= data.length) files[`model_${i.toString(16)}.mdl0`] = data.slice(i, i + size);
        } else if (magic === 0x54455830) {
            const size = view.getUint32(i + 4);
            if (size > 64 && i + size <= data.length) files[`tex_${i.toString(16)}.tex0`] = data.slice(i, i + size);
        }
    }
    return files;
}

export function extractSZS(buffer: ArrayBuffer): Record<string, Uint8Array> {
  const data = new Uint8Array(buffer);
  const decompressed = decompressYaz0(data);
  const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
  const magic = view.getUint32(0);
  let files: Record<string, Uint8Array> = {};
  if (magic === 0x55AA382D) files = parseU8(decompressed);
  else if (magic === 0x62726573) files = parseBRRES(decompressed);
  else files = { "data.bin": decompressed };
  const finalFiles: Record<string, Uint8Array> = {};
  const processFiles = (fileList: Record<string, Uint8Array>, prefix: string = "") => {
    Object.entries(fileList).forEach(([name, content]) => {
      if (content.length < 8) { finalFiles[prefix + name] = content; return; }
      const subView = new DataView(content.buffer, content.byteOffset, content.byteLength);
      const subMagic = subView.getUint32(0);
      if (subMagic === 0x62726573) processFiles(parseBRRES(content), prefix + name + "/");
      else if (subMagic === 0x55AA382D) processFiles(parseU8(content), prefix + name + "/");
      else finalFiles[prefix + name] = content;
    });
  };
  processFiles(files);
  return finalFiles;
}

export interface MDL0Model { 
    name: string; 
    nodes: MDL0Node[]; 
    geometries: MDL0Geometry[];
    materials: MDL0MaterialInfo[];
}
export interface MDL0Node { 
    name: string; 
    geometryIdx: number; 
    materialIdx?: number;
}
export interface MDL0MaterialInfo {
    name: string;
    texture?: string;
    wrapS: number;
    wrapT: number;
}
export interface MDL0Geometry { attributes: { position: Float32Array; uv?: Float32Array; }; indices: Uint32Array; }

export function parseMDL0(buffer: ArrayBuffer, name: string = "model"): MDL0Model {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    if (view.getUint32(0) !== 0x4D444C30) throw new Error("Not a valid MDL0 file");

    const version = view.getUint32(8);
    const model: MDL0Model = { name, nodes: [], geometries: [], materials: [] };

    // Section Offsets (BrawlLib IndexBank)
    const offsets: number[] = [];
    const numOffsets = version >= 10 ? 14 : 11;
    for (let i = 0; i < numOffsets; i++) offsets.push(view.getInt32(0x10 + (i * 4), false));

    const getResourceMap = (idx: number) => {
        if (idx < 0 || idx >= offsets.length || offsets[idx] <= 0) return [];
        const groupOff = offsets[idx];
        if (groupOff + 8 > buffer.byteLength) return [];
        const numEntries = view.getUint32(groupOff + 4, false);
        const map = [];
        for (let i = 1; i <= numEntries; i++) {
            const entryOff = groupOff + 0x08 + (i * 0x10);
            if (entryOff + 16 > buffer.byteLength) break;
            const strOff = view.getInt32(entryOff + 8, false);
            const dataOff = view.getInt32(entryOff + 12, false);
            const resNameOff = groupOff + strOff;
            let resName = "";
            let p = resNameOff;
            while (p < u8.length && u8[p] !== 0) resName += String.fromCharCode(u8[p++]);
            map.push({ name: resName, offset: groupOff + dataOff });
        }
        return map;
    };

    const vtxList = getResourceMap(2);
    const uvList = getResourceMap(5);
    const matList = getResourceMap(version >= 10 ? 8 : 6); // v10+ uses 8, v9 uses 6
    const polyIdx = version >= 10 ? 10 : 8; // v10+ uses 10, v9 uses 8
    const polyList = getResourceMap(polyIdx);
    const defsList = getResourceMap(0);

    // Parse Materials
    matList.forEach(m => {
        const mOff = m.offset;
        if (mOff + 0x34 > buffer.byteLength) return;
        const mView = new DataView(buffer, mOff);
        const numTextures = mView.getUint32(0x2C, false);
        const refOff = mView.getUint32(0x30, false);
        let textureName = "";
        let wrapS = 1, wrapT = 1;

        if (numTextures > 0 && refOff > 0 && (mOff + refOff + 0x34 <= buffer.byteLength)) {
            const trOff = mOff + refOff;
            const trView = new DataView(buffer, trOff);
            const texStrOff = trView.getInt32(0, false);
            const texNameOff = trOff + texStrOff;
            if (texNameOff > 0 && texNameOff < u8.length) {
                let p = texNameOff;
                while (p < u8.length && u8[p] !== 0) textureName += String.fromCharCode(u8[p++]);
            }
            wrapS = trView.getInt32(0x18, false);
            wrapT = trView.getInt32(0x1C, false);
        }
        model.materials.push({ name: m.name, texture: textureName, wrapS, wrapT });
    });

    // Parse Draw Lists (Definitions) to map Polygons to Materials
    const polyToMat = new Map<number, number>();
    defsList.forEach(d => {
        if (d.name !== "DrawOpa" && d.name !== "DrawXlu") return;
        let p = d.offset;
        while (p < u8.length) {
            const cmd = u8[p++];
            if (cmd === 0) break; // End of list
            if (cmd === 4) { // Draw (NodeType 4)
                if (p + 6 > u8.length) break;
                const matIdx = view.getUint16(p, false);
                const polyIdx = view.getUint16(p + 2, false);
                polyToMat.set(polyIdx, matIdx);
                p += 7;
            } else if (cmd === 2) p += 4;
            else if (cmd === 3) {
                if (p + 2 > u8.length) break;
                const num = u8[p + 2];
                p += 2 + (num * 6);
            } else if (cmd === 5) p += 4;
            else if (cmd === 6) p += 4;
        }
    });

    const vtxGroups = vtxList.map(v => {
        if (v.offset + 0x20 > buffer.byteLength) return null;
        const vView = new DataView(buffer, v.offset);
        return {
            offset: v.offset + vView.getInt32(0x08, false),
            count: vView.getUint16(0x1E, false),
            stride: vView.getUint8(0x1D),
            type: vView.getInt32(0x18, false),
            divisor: Math.pow(2, vView.getUint8(0x1C))
        };
    }).filter(g => g !== null);

    const uvGroups = uvList.map(u => {
        if (u.offset + 0x20 > buffer.byteLength) return null;
        const uView = new DataView(buffer, u.offset);
        return {
            offset: u.offset + uView.getInt32(0x08, false),
            count: uView.getUint16(0x1E, false),
            stride: uView.getUint8(0x1D),
            type: uView.getInt32(0x18, false),
            divisor: Math.pow(2, uView.getUint8(0x1C))
        };
    }).filter(g => g !== null);

    polyList.forEach((poly, pIdx) => {
        const pOff = poly.offset;
        if (pOff + 0x64 > buffer.byteLength) return;
        const polyView = new DataView(buffer, pOff);
        const vcdLo = polyView.getUint32(0x0C, false);
        const vcdHi = polyView.getUint32(0x10, false);
        const vtxId = polyView.getUint16(0x48, false);
        const uv0Id = polyView.getUint16(0x50, false);
        
        const dlSize = polyView.getUint32(0x28, false);
        const dlRel = polyView.getUint32(0x2C, false); 
        const pStart = pOff + 0x24 + dlRel;
        const pEnd = pStart + dlSize;

        if (pStart >= u8.length || !vtxGroups[vtxId]) return;

        const vtxGrp = vtxGroups[vtxId];
        const uvGrp = uvGroups[uv0Id];

        const getFmtSize = (fmt: number) => (fmt === 3 ? 2 : (fmt === 2 ? 1 : 0));
        const hasPosNrmMtx = (vcdLo >> 0) & 1;
        const texMtxMask = (vcdLo >> 1) & 0xFF;
        const posFmt = (vcdLo >> 9) & 3;
        const nrmFmt = (vcdLo >> 11) & 3;
        const col0Fmt = (vcdLo >> 13) & 3;
        const col1Fmt = (vcdLo >> 15) & 3;
        
        let dlStride = 0;
        if (hasPosNrmMtx) dlStride += 1;
        for (let i = 0; i < 8; i++) if ((texMtxMask >> i) & 1) dlStride += 1;
        
        const posOff = dlStride; dlStride += getFmtSize(posFmt);
        dlStride += getFmtSize(nrmFmt);
        dlStride += getFmtSize(col0Fmt) + getFmtSize(col1Fmt);
        
        const uv0Fmt = (vcdHi >> 0) & 3;
        const uv0Off = dlStride; dlStride += getFmtSize(uv0Fmt);

        if (dlStride === 0) return;

        const maxVerts = 65535;
        const tempPos = new Float32Array(maxVerts * 3);
        const tempUVs = new Float32Array(maxVerts * 2);
        const tempIdx = new Uint32Array(maxVerts * 3);
        let vPtr = 0, iPtr = 0, p = pStart;

        while (p + 1 < pEnd && p < u8.length) {
            const cmd = u8[p++];
            if (cmd === 0) continue;
            if (cmd < 0x80) { 
                if (cmd === 0x61 || (cmd >= 0x20 && cmd <= 0x38)) p += 4; 
                else if (cmd === 0x10) p += 1;
                continue; 
            }
            
            if (p + 2 > pEnd) break;
            const count = (u8[p] << 8) | u8[p+1]; p += 2;
            const baseIdx = vPtr / 3;

            for (let i = 0; i < count; i++) {
                if (p + dlStride > pEnd) break;
                const vIdx = posFmt === 3 ? view.getUint16(p + posOff, false) : u8[p + posOff];
                if (vIdx < vtxGrp.count) {
                    const b = vtxGrp.offset + vIdx * vtxGrp.stride, d = vtxGrp.divisor;
                    if (b + (vtxGrp.type === 4 ? 12 : 6) <= buffer.byteLength) {
                        if (vtxGrp.type === 4) { tempPos[vPtr]=view.getFloat32(b,false); tempPos[vPtr+1]=view.getFloat32(b+4,false); tempPos[vPtr+2]=view.getFloat32(b+8,false); }
                        else if (vtxGrp.type === 3) { tempPos[vPtr]=view.getInt16(b,false)/d; tempPos[vPtr+1]=view.getInt16(b+2,false)/d; tempPos[vPtr+2]=view.getInt16(b+4,false)/d; }
                        else if (vtxGrp.type === 2) { tempPos[vPtr]=view.getUint16(b,false)/d; tempPos[vPtr+1]=view.getUint16(b+2,false)/d; tempPos[vPtr+2]=view.getUint16(b+4,false)/d; }
                        else if (vtxGrp.type === 1) { tempPos[vPtr]=view.getInt8(b)/d; tempPos[vPtr+1]=view.getInt8(b+1)/d; tempPos[vPtr+2]=view.getInt8(b+2)/d; }
                        else if (vtxGrp.type === 0) { tempPos[vPtr]=u8[b]/d; tempPos[vPtr+1]=u8[b+1]/d; tempPos[vPtr+2]=u8[b+2]/d; }
                    }
                }
                if (uvGrp) {
                    const uIdx = uv0Fmt === 3 ? view.getUint16(p + uv0Off, false) : u8[p + uv0Off];
                    if (uIdx < uvGrp.count) {
                        const b = uvGrp.offset + uIdx * uvGrp.stride, d = uvGrp.divisor;
                        if (b + (uvGrp.type === 4 ? 8 : 4) <= buffer.byteLength) {
                            if (uvGrp.type === 4) { tempUVs[(vPtr/3)*2]=view.getFloat32(b,false); tempUVs[(vPtr/3)*2+1]=1.0-view.getFloat32(b+4,false); }
                            else if (uvGrp.type === 3) { tempUVs[(vPtr/3)*2]=view.getInt16(b,false)/d; tempUVs[(vPtr/3)*2+1]=1.0-view.getInt16(b+2,false)/d; }
                            else if (uvGrp.type === 2) { tempUVs[(vPtr/3)*2]=view.getUint16(b,false)/d; tempUVs[(vPtr/3)*2+1]=1.0-view.getUint16(b+2,false)/d; }
                        }
                    }
                }
                vPtr += 3; p += dlStride;
            }

            if (cmd === 0x90 || cmd === 0x80) { 
                const step = cmd === 0x80 ? 4 : 3;
                for (let i = 0; i < count; i += step) { 
                    if (iPtr + 3 > tempIdx.length) break;
                    tempIdx[iPtr++] = baseIdx + i + 2; tempIdx[iPtr++] = baseIdx + i + 1; tempIdx[iPtr++] = baseIdx + i; 
                    if (cmd === 0x80) { if (iPtr + 3 > tempIdx.length) break; tempIdx[iPtr++] = baseIdx + i + 2; tempIdx[iPtr++] = baseIdx + i + 3; tempIdx[iPtr++] = baseIdx + i; }
                }
            } else if (cmd === 0x98) { 
                for (let i = 2; i < count; i++) { if (iPtr + 3 > tempIdx.length) break; if (i % 2 === 0) { tempIdx[iPtr++] = baseIdx + i; tempIdx[iPtr++] = baseIdx + i - 1; tempIdx[iPtr++] = baseIdx + i - 2; } else { tempIdx[iPtr++] = baseIdx + i; tempIdx[iPtr++] = baseIdx + i - 2; tempIdx[iPtr++] = baseIdx + i - 1; } }
            } else if (cmd === 0xA0) {
                for (let i = 1; i < count - 1; i++) { if (iPtr + 3 > tempIdx.length) break; tempIdx[iPtr++] = baseIdx; tempIdx[iPtr++] = baseIdx + i; tempIdx[iPtr++] = baseIdx + i + 1; }
            }
        }
        
        const matIdx = polyToMat.get(pIdx);
        model.geometries.push({ attributes: { position: tempPos.slice(0, vPtr), uv: uvGrp ? tempUVs.slice(0, (vPtr/3)*2) : undefined }, indices: tempIdx.slice(0, iPtr) });
        model.nodes.push({ name: poly.name, geometryIdx: model.geometries.length - 1, materialIdx: matIdx });
    });

    return model;
}

export function decodeTEX0(data: Uint8Array): { width: number, height: number, rgba: Uint8Array } | null {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== 0x54455830) return null;
    const width = view.getUint16(0x1C, false), height = view.getUint16(0x1E, false), format = view.getUint32(0x20, false);
    const dataOff = view.getUint32(0x34, false), pixelData = data.slice(dataOff);
    if (format === 14) return { width, height, rgba: decodeCMPR(pixelData, width, height) };
    if (format === 5) return { width, height, rgba: decodeRGB5A3(pixelData, width, height) };
    return null;
}

function decodeCMPR(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 0;
    const decodeBlock = (off: number, x: number, y: number) => {
        if (off + 8 > data.length) return;
        const c0 = view.getUint16(off, false), c1 = view.getUint16(off + 2, false), bits = view.getUint32(off + 4, false);
        const r0 = ((c0 >> 11) & 0x1F) << 3, g0 = ((c0 >> 5) & 0x3F) << 2, b0 = (c0 & 0x1F) << 3, r1 = ((c1 >> 11) & 0x1F) << 3, g1 = ((c1 >> 5) & 0x3F) << 2, b1 = (c1 & 0x1F) << 3;
        const colors = [ [r0, g0, b0, 255], [r1, g1, b1, 255], c0 > c1 ? [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255] : [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255], c0 > c1 ? [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255] : [0, 0, 0, 0] ];
        for (let i = 0; i < 16; i++) {
            const ix = i % 4, iy = Math.floor(i / 4); if (x + ix >= width || y + iy >= height) continue;
            const c = colors[(bits >> (30 - i * 2)) & 0x03];
            const outOff = ((y + iy) * width + (x + ix)) * 4; output[outOff] = c[0]; output[outOff+1] = c[1]; output[outOff+2] = c[2]; output[outOff+3] = c[3];
        }
    };
    for (let ty = 0; ty < height; ty += 8) for (let tx = 0; tx < width; tx += 8) for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) { decodeBlock(p, tx + bx * 4, ty + by * 4); p += 8; }
    return output;
}

function decodeRGB5A3(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 0;
    for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 4) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) {
        if (p + 2 > data.length) break;
        const c = view.getUint16(p, false); p += 2;
        let r, g, b, a;
        if (c & 0x8000) { r = ((c >> 10) & 0x1F) << 3; g = ((c >> 5) & 0x1F) << 3; b = (c & 0x1F) << 3; a = 255; }
        else { a = ((c >> 12) & 0x07) << 5; r = ((c >> 8) & 0x0F) << 4; g = ((c >> 4) & 0x0F) << 4; b = (c & 0x0F) << 4; }
        const outOff = ((ty + iy) * width + (tx + ix)) * 4; if (outOff < output.length) { output[outOff] = r; output[outOff+1] = g; output[outOff+2] = b; output[outOff+3] = a; }
    }
    return output;
}

export function createBMP(rgba: Uint8Array, width: number, height: number): Uint8Array {
    const fileHeaderSize = 14, infoHeaderSize = 40, pixelDataSize = width * height * 4;
    const fileSize = fileHeaderSize + infoHeaderSize + pixelDataSize;
    const buffer = new ArrayBuffer(fileSize), view = new DataView(buffer), u8 = new Uint8Array(buffer);
    u8[0] = 0x42; u8[1] = 0x4D; view.setUint32(2, fileSize, true); view.setUint32(10, fileHeaderSize + infoHeaderSize, true);
    view.setUint32(14, infoHeaderSize, true); view.setInt32(18, width, true); view.setInt32(22, -height, true); 
    view.setUint16(26, 1, true); view.setUint16(28, 32, true); 
    let p = fileHeaderSize + infoHeaderSize;
    for (let i = 0; i < rgba.length; i += 4) { u8[p++] = rgba[i+2]; u8[p++] = rgba[i+1]; u8[p++] = rgba[i]; u8[p++] = rgba[i+3]; }
    return u8;
}
