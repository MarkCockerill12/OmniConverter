export function decodeTEX0(data: Uint8Array): { width: number, height: number, rgba: Uint8Array } | null {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== 0x54455830) return null;
    const width = view.getUint16(0x1C, false), height = view.getUint16(0x1E, false), format = view.getUint32(0x20, false);
    const dataOff = view.getUint32(0x34, false), pixelData = data.slice(dataOff);
    if (format === 14) return { width, height, rgba: decodeCMPR(pixelData, width, height) };
    if (format === 6) return { width, height, rgba: decodeRGBA8(pixelData, width, height) };
    if (format === 5) return { width, height, rgba: decodeRGB5A3(pixelData, width, height) };
    if (format === 4) return { width, height, rgba: decodeRGB565(pixelData, width, height) };
    if (format === 3) return { width, height, rgba: decodeIA8(pixelData, width, height) };
    if (format === 2) return { width, height, rgba: decodeIA4(pixelData, width, height) };
    if (format === 1) return { width, height, rgba: decodeI8(pixelData, width, height) };
    if (format === 0) return { width, height, rgba: decodeI4(pixelData, width, height) };
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

function decodeI4(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    let p = 0;
    for (let ty = 0; ty < height; ty += 8) for (let tx = 0; tx < width; tx += 8) for (let iy = 0; iy < 8; iy++) for (let ix = 0; ix < 8; ix += 2) {
        if (p >= data.length) break;
        const b = data[p++];
        const v1 = (b >> 4) * 17, v2 = (b & 0xF) * 17;
        const o1 = ((ty + iy) * width + (tx + ix)) * 4, o2 = ((ty + iy) * width + (tx + ix + 1)) * 4;
        if (o1 < output.length) { output[o1]=output[o1+1]=output[o1+2]=v1; output[o1+3]=255; }
        if (o2 < output.length) { output[o2]=output[o2+1]=output[o2+2]=v2; output[o2+3]=255; }
    }
    return output;
}

function decodeI8(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    let p = 0;
    for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 8) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 8; ix++) {
        if (p >= data.length) break;
        const v = data[p++];
        const outOff = ((ty + iy) * width + (tx + ix)) * 4;
        if (outOff < output.length) { output[outOff]=output[outOff+1]=output[outOff+2]=v; output[outOff+3]=255; }
    }
    return output;
}

function decodeIA4(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    let p = 0;
    for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 8) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 8; ix++) {
        if (p >= data.length) break;
        const b = data[p++];
        const a = (b >> 4) * 17, i = (b & 0xF) * 17;
        const outOff = ((ty + iy) * width + (tx + ix)) * 4;
        if (outOff < output.length) { output[outOff]=output[outOff+1]=output[outOff+2]=i; output[outOff+3]=a; }
    }
    return output;
}

function decodeIA8(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    let p = 0;
    for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 4) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) {
        if (p + 1 >= data.length) break;
        const a = data[p++], i = data[p++];
        const outOff = ((ty + iy) * width + (tx + ix)) * 4;
        if (outOff < output.length) { output[outOff]=output[outOff+1]=output[outOff+2]=i; output[outOff+3]=a; }
    }
    return output;
}

function decodeRGB565(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 0;
    for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 4) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) {
        if (p + 2 > data.length) break;
        const c = view.getUint16(p, false); p += 2;
        const r = ((c >> 11) & 0x1F) << 3, g = ((c >> 5) & 0x3F) << 2, b = (c & 0x1F) << 3;
        const outOff = ((ty + iy) * width + (tx + ix)) * 4;
        if (outOff < output.length) { output[outOff]=r; output[outOff+1]=g; output[outOff+2]=b; output[outOff+3]=255; }
    }
    return output;
}

function decodeRGBA8(data: Uint8Array, width: number, height: number): Uint8Array {
    const output = new Uint8Array(width * height * 4);
    let p = 0;
    for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 4) {
        const blockAR = data.slice(p, p + 32);
        const blockGB = data.slice(p + 32, p + 64);
        p += 64;
        for (let i = 0; i < 16; i++) {
            const ix = i % 4, iy = Math.floor(i / 4);
            const a = blockAR[i * 2], r = blockAR[i * 2 + 1];
            const g = blockGB[i * 2], b = blockGB[i * 2 + 1];
            const outOff = ((ty + iy) * width + (tx + ix)) * 4;
            if (outOff < output.length) { output[outOff]=r; output[outOff+1]=g; output[outOff+2]=b; output[outOff+3]=a; }
        }
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
