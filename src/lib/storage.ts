import type { EditOptions } from "./formats";

/**
 * Queue and preference persistence.
 *
 * IndexedDB is used rather than localStorage because it can structured-clone
 * `File` objects directly, so a refresh keeps the actual media, not just names.
 */

const DB_NAME = "omni-convert";
const DB_VERSION = 1;
const QUEUE_STORE = "queue";
const SETTINGS_STORE = "settings";

export interface StoredJob {
  id: string;
  file: File;
  targetFormat: string;
  editOptions?: EditOptions;
  addedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

function run<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(storeName, mode);
          const request = action(tx.objectStore(storeName));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

/** Replaces the persisted queue with the current one. */
export async function saveQueue(jobs: StoredJob[]) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    const store = tx.objectStore(QUEUE_STORE);
    store.clear();
    for (const job of jobs) store.put(job);
  } catch {
    /* storage unavailable (private mode, quota) — persistence is best-effort */
  }
}

export async function loadQueue(): Promise<StoredJob[]> {
  const jobs = await run<StoredJob[]>(QUEUE_STORE, "readonly", (store) => store.getAll());
  return (jobs || []).sort((a, b) => a.addedAt - b.addedAt);
}

export async function clearQueue() {
  await run(QUEUE_STORE, "readwrite", (store) => store.clear());
}

export async function saveSetting(key: string, value: unknown) {
  await run(SETTINGS_STORE, "readwrite", (store) => store.put(value, key));
}

export async function loadSetting<T>(key: string): Promise<T | null> {
  return (await run<T>(SETTINGS_STORE, "readonly", (store) => store.get(key))) ?? null;
}
