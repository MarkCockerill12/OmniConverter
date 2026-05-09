/**
 * Origin Private File System (OPFS) Utilities
 * Used for streaming multi-gigabyte files on low-RAM devices.
 */

export async function getOPFSDirectory() {
  return await navigator.storage.getDirectory();
}

export async function writeToOPFS(fileName: string, stream: ReadableStream) {
  const root = await getOPFSDirectory();
  const fileHandle = await root.getFileHandle(fileName, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await stream.pipeTo(writable);
}

export async function readFromOPFS(fileName: string) {
  const root = await getOPFSDirectory();
  const fileHandle = await root.getFileHandle(fileName);
  return await fileHandle.getFile();
}
