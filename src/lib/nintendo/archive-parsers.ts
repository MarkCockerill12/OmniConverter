import { decompressYaz0 } from "./decompressors";
import { decodeTEX0, createBMP } from "./tex0-decoders";

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
    if (data.length < 16 || view.getUint32(0) !== 0x62726573) return {};
    const files: Record<string, Uint8Array> = {};
    
    // BRRES Header: Magic(4), Endian(2), Version(2), Size(4), HeaderSize(2), Sections(2)
    const headerSize = view.getUint16(0x0C, false);
    const numSections = view.getUint16(0x0E, false);
    
    const getNames = (groupOff: number) => {
        const names = new Map<string, number>();
        if (groupOff <= 0 || groupOff + 8 > data.length) return names;
        const numEntries = view.getUint32(groupOff + 4, false);
        if (numEntries > 2048) return names; // Increased limit slightly
        for (let i = 1; i <= numEntries; i++) {
            const entryOff = groupOff + 0x08 + (i * 0x10);
            if (entryOff + 16 > data.length) break;
            const strOff = view.getUint32(entryOff + 8, false);
            const dataOff = view.getUint32(entryOff + 12, false);
            let name = "";
            let p = groupOff + strOff;
            if (p > 0 && p < data.length) {
                while (p < data.length && data[p] !== 0 && name.length < 128) name += String.fromCharCode(data[p++]);
            }
            if (name && dataOff > 0 && groupOff + dataOff < data.length) names.set(name, groupOff + dataOff);
        }
        return names;
    };

    let currentOff = headerSize;
    for (let s = 0; s < numSections; s++) {
        if (currentOff + 8 > data.length) break;
        const sectionMagic = view.getUint32(currentOff, false);
        const sectionSize = view.getUint32(currentOff + 4, false);
        
        if (sectionMagic === 0x726F6F74) { // 'root'
            const rootGroupOff = currentOff + 8;
            const categories = getNames(rootGroupOff);
            categories.forEach((catOff, catName) => {
                const subFiles = getNames(catOff);
                subFiles.forEach((fileOff, fileName) => {
                    if (fileOff < 0 || fileOff + 8 > data.length) return;
                    const magic = view.getUint32(fileOff, false);
                    const size = view.getUint32(fileOff + 4, false);
                    if (size > 8 && fileOff + size <= data.length) {
                        const ext = magic === 0x4D444C30 ? ".mdl0" : (magic === 0x54455830 ? ".tex0" : ".bin");
                        files[`${catName}/${fileName}${ext}`] = data.slice(fileOff, fileOff + size);
                    }
                });
            });
        }
        currentOff += sectionSize;
        if (sectionSize === 0) break; // Prevent infinite loop
    }
    
    return files;
}

export function extractSZS(buffer: ArrayBuffer): Record<string, Uint8Array> {
    const data = new Uint8Array(buffer);
    const decompressed = decompressYaz0(data);
    const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    if (decompressed.length < 8) return { "data.bin": decompressed };
    
    const finalFiles: Record<string, Uint8Array> = {};
    
    const processFiles = (fileList: Record<string, Uint8Array>, prefix: string = "") => {
        Object.entries(fileList).forEach(([name, content]) => {
            if (content.length < 8) { finalFiles[prefix + name] = content; return; }
            const subView = new DataView(content.buffer, content.byteOffset, content.byteLength);
            const subMagic = subView.getUint32(0);
            
            let extracted: Record<string, Uint8Array> | null = null;
            if (subMagic === 0x62726573) extracted = parseBRRES(content);
            else if (subMagic === 0x55AA382D) extracted = parseU8(content);
            
            if (extracted && Object.keys(extracted).length > 0) {
                processFiles(extracted, prefix + name + "/");
            } else {
                finalFiles[prefix + name] = content;
            }
        });
    };

    const magic = view.getUint32(0);
    if (magic === 0x55AA382D) processFiles(parseU8(decompressed));
    else if (magic === 0x62726573) processFiles(parseBRRES(decompressed));
    else finalFiles["data.bin"] = decompressed;

    return finalFiles;
}
