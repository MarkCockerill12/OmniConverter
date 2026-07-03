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
    textures: string[];
    texture?: string; // Legacy for single texture access
    wrapS: number;
    wrapT: number;
}
export interface MDL0Geometry { attributes: { position: Float32Array; normal?: Float32Array; uv?: Float32Array; }; indices: Uint32Array; }

export function parseMDL0(buffer: ArrayBuffer, name: string = "model"): MDL0Model {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    if (view.getUint32(0) !== 0x4D444C30) throw new Error("Not a valid MDL0 file");

    const version = view.getUint32(8);
    const model: MDL0Model = { name, nodes: [], geometries: [], materials: [] };

    const offsets: number[] = [];
    const numOffsets = version >= 10 ? 15 : 11;
    for (let i = 0; i < numOffsets; i++) offsets.push(view.getInt32(0x10 + (i * 4), false));

    const getString = (off: number, ...bases: number[]) => {
        if (off <= 0) return "";
        for (const base of bases) {
            let p = base + off;
            if (p < 0 || p >= u8.length || u8[p] === 0) continue;
            let name = "";
            let curr = p;
            let isJunk = false;
            while (curr < u8.length && u8[curr] !== 0 && name.length < 128) {
                const c = u8[curr++];
                if (c < 32 || c > 126) { isJunk = true; break; }
                name += String.fromCharCode(c);
            }
            if (!isJunk && name.length > 0) return name;
        }
        return "";
    };

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
            
            // MDL0 strings can be relative to the IndexGroup or Absolute
            const resName = getString(strOff, 0, groupOff, entryOff);
            map.push({ name: resName || `obj_${i}`, offset: groupOff + dataOff });
        }
        return map;
    };

    const matIdxGroup = version >= 10 ? 8 : 6;
    const polyIdxGroup = version >= 10 ? 10 : 8;

    const vtxList = getResourceMap(2);
    const nrmList = getResourceMap(3);
    const uvList = getResourceMap(5);
    const matList = getResourceMap(matIdxGroup); 
    const polyList = getResourceMap(polyIdxGroup);
    const defsList = getResourceMap(0);

    matList.forEach(m => {
        const mOff = m.offset;
        if (mOff + 0x34 > buffer.byteLength) return;
        const mView = new DataView(buffer, mOff);
        const numTextures = mView.getUint32(0x2C, false);
        const refOff = mView.getInt32(0x30, false);
        const textures: string[] = [];
        let wrapS = 1, wrapT = 1;

        if (numTextures > 0 && refOff > 0) {
            for (let t = 0; t < Math.min(numTextures, 8); t++) {
                const trOff = mOff + refOff + (t * 0x34);
                if (trOff + 0x34 <= buffer.byteLength) {
                    const trView = new DataView(buffer, trOff);
                    const texStrOff = trView.getInt32(0, false);
                    
                    const textureName = getString(texStrOff, 0, trOff, mOff);
                    if (textureName) textures.push(textureName);
                    if (t === 0) {
                        wrapS = trView.getInt32(0x18, false);
                        wrapT = trView.getInt32(0x1C, false);
                    }
                }
            }
        }
        model.materials.push({ name: m.name, textures, texture: textures[0] || "", wrapS, wrapT });
    });

    const polyToMat = new Map<number, number>();
    defsList.forEach(d => {
        if (d.name !== "DrawOpa" && d.name !== "DrawXlu") return;
        let p = d.offset;
        while (p < u8.length) {
            const cmd = u8[p++];
            if (cmd === 0) break;
            if (cmd === 4) {
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
            } else if (cmd === 5 || cmd === 6) p += 4;
        }
    });

    const getGroupData = (list: any[]) => list.map(v => {
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

    const vtxGroups = getGroupData(vtxList);
    const nrmGroups = getGroupData(nrmList);
    const uvGroups = getGroupData(uvList);

    polyList.forEach((poly, pIdx) => {
        const pOff = poly.offset;
        if (pOff + 0x64 > buffer.byteLength) return;
        const polyView = new DataView(buffer, pOff);
        const vcdLo = polyView.getUint32(0x0C, false);
        const vcdHi = polyView.getUint32(0x10, false);
        
        const vtxId = polyView.getUint16(0x48, false);
        const nrmId = polyView.getUint16(0x4A, false);
        const uv0Id = polyView.getUint16(0x50, false);
        
        const dlSize = polyView.getUint32(0x28, false);
        const dlRel = polyView.getUint32(0x2C, false); 
        const pStart = pOff + 0x24 + dlRel;
        const pEnd = pStart + dlSize;

        if (pStart >= u8.length || !vtxGroups[vtxId]) return;

        const vtxGrp = vtxGroups[vtxId]!;
        const nrmGrp = nrmGroups[nrmId];
        const uvGrp = uvGroups[uv0Id];

        const getFmtSize = (fmt: number) => (fmt === 3 ? 2 : (fmt === 2 ? 1 : 0));
        
        const hasPosNrmMtx = (vcdLo >> 0) & 1;
        const texMtxMask = (vcdLo >> 1) & 0xFF;
        const posFmt = (vcdLo >> 9) & 3;
        const nrmFmt = (vcdLo >> 11) & 3;
        const col0Fmt = (vcdLo >> 13) & 3;
        const col1Fmt = (vcdLo >> 15) & 3;
        const uv0Fmt = (vcdHi >> 0) & 3;
        
        let dlStride = 0;
        if (hasPosNrmMtx) dlStride += 1;
        for (let i = 0; i < 8; i++) if ((texMtxMask >> i) & 1) dlStride += 1;
        
        const posOff = dlStride; dlStride += getFmtSize(posFmt);
        const nrmOff = dlStride; dlStride += getFmtSize(nrmFmt);
        const col0Off = dlStride; dlStride += getFmtSize(col0Fmt);
        const col1Off = dlStride; dlStride += getFmtSize(col1Fmt);
        const uv0Off = dlStride; dlStride += getFmtSize(uv0Fmt);

        if (dlStride === 0) return;

        const maxVerts = 65535;
        const tempPos = new Float32Array(maxVerts * 3);
        const tempNrm = new Float32Array(maxVerts * 3);
        const tempUVs = new Float32Array(maxVerts * 2);
        const tempIdx = new Uint32Array(maxVerts * 6); 
        let vPtr = 0, iPtr = 0, p = pStart;

        const readValue = (ptr: number, g: any) => {
            if (!g) return null;
            const b = g.offset + ptr * g.stride, d = g.divisor;
            if (b + (g.type === 4 ? 12 : 6) > buffer.byteLength) return [0,0,0];
            if (g.type === 4) return [view.getFloat32(b,false), view.getFloat32(b+4,false), view.getFloat32(b+8,false)];
            if (g.type === 3) return [view.getInt16(b,false)/d, view.getInt16(b+2,false)/d, view.getInt16(b+4,false)/d];
            if (g.type === 2) return [view.getUint16(b,false)/d, view.getUint16(b+2,false)/d, view.getUint16(b+4,false)/d];
            if (g.type === 1) return [view.getInt8(b)/d, view.getInt8(b+1)/d, view.getInt8(b+2)/d];
            return [u8[b]/d, u8[b+1]/d, u8[b+2]/d];
        };

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
                
                const vIdx = posFmt === 3 ? view.getUint16(p + posOff, false) : (posFmt === 2 ? u8[p + posOff] : -1);
                if (vIdx >= 0 && vIdx < vtxGrp.count) {
                    const vals = readValue(vIdx, vtxGrp);
                    if (vals) { tempPos[vPtr] = vals[0]; tempPos[vPtr+1] = vals[1]; tempPos[vPtr+2] = vals[2]; }
                }

                if (nrmFmt !== 0 && nrmGrp) {
                    const nIdx = nrmFmt === 3 ? view.getUint16(p + nrmOff, false) : (nrmFmt === 2 ? u8[p + nrmOff] : -1);
                    if (nIdx >= 0 && nIdx < nrmGrp.count) {
                        const vals = readValue(nIdx, nrmGrp);
                        if (vals) { tempNrm[vPtr] = vals[0]; tempNrm[vPtr+1] = vals[1]; tempNrm[vPtr+2] = vals[2]; }
                    }
                }

                if (uv0Fmt !== 0 && uvGrp) {
                    const uIdx = uv0Fmt === 3 ? view.getUint16(p + uv0Off, false) : (uv0Fmt === 2 ? u8[p + uv0Off] : -1);
                    if (uIdx >= 0 && uIdx < uvGrp.count) {
                        const b = uvGrp.offset + uIdx * uvGrp.stride, d = uvGrp.divisor;
                        if (b + (uvGrp.type === 4 ? 8 : 4) <= buffer.byteLength) {
                            if (uvGrp.type === 4) { tempUVs[(vPtr/3)*2]=view.getFloat32(b,false); tempUVs[(vPtr/3)*2+1]=1.0-view.getFloat32(b+4,false); }
                            else if (uvGrp.type === 3) { tempUVs[(vPtr/3)*2]=view.getInt16(b,false)/d; tempUVs[(vPtr/3)*2+1]=1.0-view.getInt16(b+2,false)/d; }
                            else if (uvGrp.type === 2) { tempUVs[(vPtr/3)*2]=view.getUint16(b,false)/d; tempUVs[(vPtr/3)*2+1]=1.0-view.getUint16(b+2,false)/d; }
                            else if (uvGrp.type === 1) { tempUVs[(vPtr/3)*2]=view.getInt8(b)/d; tempUVs[(vPtr/3)*2+1]=1.0-view.getInt8(b+1)/d; }
                            else { tempUVs[(vPtr/3)*2]=u8[b]/d; tempUVs[(vPtr/3)*2+1]=1.0-u8[b+1]/d; }
                        }
                    }
                }
                vPtr += 3; p += dlStride;
            }

            if (cmd === 0x90 || cmd === 0x80) { 
                const step = cmd === 0x80 ? 4 : 3;
                for (let i = 0; i < count; i += step) { 
                    if (iPtr + 3 > tempIdx.length) break;
                    tempIdx[iPtr++] = baseIdx + i; tempIdx[iPtr++] = baseIdx + i + 1; tempIdx[iPtr++] = baseIdx + i + 2; 
                    if (cmd === 0x80) { if (iPtr + 3 > tempIdx.length) break; tempIdx[iPtr++] = baseIdx + i; tempIdx[iPtr++] = baseIdx + i + 2; tempIdx[iPtr++] = baseIdx + i + 3; }
                }
            } else if (cmd === 0x98) { 
                for (let i = 2; i < count; i++) { if (iPtr + 3 > tempIdx.length) break; if (i % 2 === 0) { tempIdx[iPtr++] = baseIdx + i - 2; tempIdx[iPtr++] = baseIdx + i - 1; tempIdx[iPtr++] = baseIdx + i; } else { tempIdx[iPtr++] = baseIdx + i - 1; tempIdx[iPtr++] = baseIdx + i - 2; tempIdx[iPtr++] = baseIdx + i; } }
            } else if (cmd === 0xA0) {
                for (let i = 1; i < count - 1; i++) { if (iPtr + 3 > tempIdx.length) break; tempIdx[iPtr++] = baseIdx; tempIdx[iPtr++] = baseIdx + i; tempIdx[iPtr++] = baseIdx + i + 1; }
            }
        }
        
        const matIdx = polyToMat.get(pIdx);
        model.geometries.push({ 
            attributes: { 
                position: tempPos.slice(0, vPtr), 
                normal: (nrmFmt !== 0 && nrmGrp) ? tempNrm.slice(0, vPtr) : undefined,
                uv: uvGrp ? tempUVs.slice(0, (vPtr/3)*2) : undefined 
            }, 
            indices: tempIdx.slice(0, iPtr) 
        });
        model.nodes.push({ name: poly.name, geometryIdx: model.geometries.length - 1, materialIdx: matIdx });
    });

    return model;
}
