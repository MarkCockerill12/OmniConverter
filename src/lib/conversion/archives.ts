import { unzipSync, zipSync, gzipSync, gunzipSync } from "fflate";
import { getExtension } from "@/lib/utils";

/**
 * Archive repacking. fflate covers ZIP and gzip; TAR is a 512-byte-header
 * format that is cheaper to implement than to depend on.
 */

export type ArchiveEntries = Record<string, Uint8Array>;

const TEXT = new TextEncoder();
const DECODER = new TextDecoder();

function readOctal(bytes: Uint8Array, offset: number, length: number) {
  const text = DECODER.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/, "").trim();
  return text ? parseInt(text, 8) : 0;
}

export function untar(data: Uint8Array): ArchiveEntries {
  const entries: ArchiveEntries = {};
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive padding

    const rawName = DECODER.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = DECODER.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;

    if (name && (type === "0" || type === "\0" || type === "48")) {
      entries[name] = data.slice(offset, offset + size);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function tar(entries: ArchiveEntries): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const [path, data] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    const name = TEXT.encode(path.slice(0, 100));
    header.set(name, 0);
    header.set(TEXT.encode("0000644\0"), 100); // mode
    header.set(TEXT.encode("0000000\0"), 108); // uid
    header.set(TEXT.encode("0000000\0"), 116); // gid
    header.set(TEXT.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    header.set(TEXT.encode(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0"), 136);
    header.set(TEXT.encode("        "), 148); // checksum placeholder (spaces)
    header[156] = 0x30; // typeflag '0' = regular file
    header.set(TEXT.encode("ustar\0"), 257);
    header.set(TEXT.encode("00"), 263);

    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(TEXT.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);

    blocks.push(header);
    blocks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(new Uint8Array(padding));
  }

  blocks.push(new Uint8Array(1024)); // two empty blocks terminate the archive

  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** True for names this module knows how to read. */
export function isReadableArchive(fileName: string) {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".gz") || lower.endsWith(".tgz");
}

/** Unpacks ZIP, TAR, TAR.GZ or a single gzipped file into a flat entry map. */
export async function readArchive(file: File): Promise<ArchiveEntries> {
  const ext = getExtension(file.name);
  const lower = file.name.toLowerCase();
  let data: Uint8Array<ArrayBufferLike> = new Uint8Array(await file.arrayBuffer());

  if (ext === "gz" || ext === "tgz") {
    data = gunzipSync(data);
    if (lower.endsWith(".tar.gz") || ext === "tgz" || looksLikeTar(data)) return untar(data);
    return { [file.name.replace(/\.(t?gz)$/i, "") || "file"]: data };
  }
  if (ext === "tar") return untar(data);
  return unzipSync(data);
}

function looksLikeTar(data: Uint8Array) {
  return data.length > 262 && DECODER.decode(data.subarray(257, 262)) === "ustar";
}

/** Repacks an archive into another container format. */
export async function convertArchive(file: File, target: string): Promise<{ blob: Blob; extension: string }> {
  const entries = await readArchive(file);
  if (Object.keys(entries).length === 0) throw new Error("The archive is empty or unreadable.");

  switch (target.toLowerCase()) {
    case "zip":
      return { blob: new Blob([zipSync(entries) as BlobPart], { type: "application/zip" }), extension: "zip" };
    case "tar":
      return { blob: new Blob([tar(entries) as BlobPart], { type: "application/x-tar" }), extension: "tar" };
    case "gz":
      return {
        blob: new Blob([gzipSync(tar(entries)) as BlobPart], { type: "application/gzip" }),
        extension: "tar.gz",
      };
    default:
      throw new Error(`${target.toUpperCase()} is not a supported archive target.`);
  }
}

export interface ArchiveEntryInfo {
  path: string;
  size: number;
}

/** Flat listing used by the archive inspector. */
export async function inspectArchive(file: File): Promise<ArchiveEntryInfo[]> {
  const entries = await readArchive(file);
  return Object.entries(entries)
    .map(([path, data]) => ({ path, size: data.length }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
