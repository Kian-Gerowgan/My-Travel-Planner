// Minimal IndexedDB key/value store for document files kept on this device (offline copies).
const DB_NAME = 'my-travel-planner';
const STORE = 'files';

let dbPromise: Promise<IDBDatabase> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(d => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));
}

export const getFile = (id: string) => tx<Blob | undefined>('readonly', s => s.get(id)).catch(() => undefined);
export const putFile = (id: string, blob: Blob) => tx<void>('readwrite', s => s.put(blob, id));
export const deleteFile = (id: string) => tx<void>('readwrite', s => s.delete(id)).catch(() => undefined);
export const listFileIds = () => tx<IDBValidKey[]>('readonly', s => s.getAllKeys()).then(k => k.map(String)).catch(() => [] as string[]);

/** Ask the browser not to evict offline copies when storage runs low. */
export function requestPersistentStorage() {
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
}
