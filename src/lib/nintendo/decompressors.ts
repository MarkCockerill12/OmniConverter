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
