// Moves document files between this device and Google Drive:
// uploads files added on this device, keeps offline copies of documents for upcoming and
// current trips, and moves deleted documents to the Drive trash (retried when back online).
import { useCallback, useEffect, useRef, useState } from 'react';
import * as drive from './drive';
import * as idb from './idb';

interface FileDoc { id: string; tripId: string; name: string; mime: string; driveId?: string; cover?: boolean; }
interface FileTrip { id: string; name: string; end: string; }
interface SyncInfo { connected: boolean; status: string; folderId?: string; lastSync?: number; }

const TRASH_KEY = 'mtp:trash:v1';
const readTrash = (): string[] => { try { return JSON.parse(localStorage.getItem(TRASH_KEY) || '[]'); } catch { return []; } };
const writeTrash = (ids: string[]) => { try { localStorage.setItem(TRASH_KEY, JSON.stringify(ids)); } catch { /* storage unavailable */ } };
const today = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
const addDays = (s: string, d: number) => { const t = new Date(s + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

export function useFileSync(docs: FileDoc[], trips: FileTrip[], sync: SyncInfo, setDriveId: (docId: string, driveId: string) => void) {
  const [localIds, setLocalIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, 'up' | 'down'>>({});
  const running = useRef(false);
  const folders = useRef<Record<string, string>>({});
  const docsRef = useRef(docs); docsRef.current = docs;
  const tripsRef = useRef(trips); tripsRef.current = trips;

  const refreshLocal = useCallback(async () => setLocalIds(new Set(await idb.listFileIds())), []);
  useEffect(() => { refreshLocal(); idb.requestPersistentStorage(); }, [refreshLocal]);

  const ready = () => sync.connected && !!sync.folderId && drive.hasValidToken() && navigator.onLine;

  const tripFolder = async (trip: FileTrip) => {
    if (folders.current[trip.id]) return folders.current[trip.id];
    const tripsId = await drive.ensureFolder('Trips', sync.folderId);
    const tripId = await drive.ensureFolder(trip.name, tripsId);
    return (folders.current[trip.id] = await drive.ensureFolder('Documents', tripId));
  };

  const run = useCallback(async () => {
    if (running.current || !ready()) return;
    running.current = true;
    try {
      // 1. Deleted documents → Drive trash
      for (const driveId of readTrash()) {
        try { await drive.trashFile(driveId); } catch (e: any) { if (!/ 404/.test(e.message)) throw e; }
        writeTrash(readTrash().filter(x => x !== driveId));
      }
      const have = new Set(await idb.listFileIds());
      // 2. Upload files added on this device
      for (const d of docsRef.current.filter(x => !x.driveId && have.has(x.id))) {
        const trip = tripsRef.current.find(t => t.id === d.tripId);
        const blob = await idb.getFile(d.id);
        if (!trip || !blob) continue;
        setBusy(b => ({ ...b, [d.id]: 'up' }));
        try { setDriveId(d.id, (await drive.uploadBlob(await tripFolder(trip), d.name, blob)).id); }
        finally { setBusy(b => { const n = { ...b }; delete n[d.id]; return n; }); }
      }
      // 3. Offline copies for upcoming and current trips; drop them a week after a trip ends
      const keepFrom = addDays(today(), -7);
      for (const d of docsRef.current) {
        const trip = tripsRef.current.find(t => t.id === d.tripId);
        if (!trip || !d.driveId) continue;
        // Cover photos are small and shown on every trip card, so they always stay on the device.
        if ((trip.end >= keepFrom || d.cover) && !have.has(d.id)) {
          setBusy(b => ({ ...b, [d.id]: 'down' }));
          try { await idb.putFile(d.id, await drive.downloadBlob(d.driveId)); }
          finally { setBusy(b => { const n = { ...b }; delete n[d.id]; return n; }); }
        } else if (trip.end < keepFrom && !d.cover && have.has(d.id)) await idb.deleteFile(d.id);
      }
      // Remove offline copies of documents that no longer exist
      const known = new Set(docsRef.current.map(d => d.id));
      for (const id of have) if (!known.has(id)) await idb.deleteFile(id);
    } catch { /* retried on the next sync */ }
    finally { running.current = false; refreshLocal(); }
  }, [sync.connected, sync.folderId, setDriveId, refreshLocal]);

  // Run after each Drive sync and whenever documents change.
  useEffect(() => { if (sync.status === 'idle') run(); }, [sync.status, sync.lastSync, docs, run]);

  /** Returns the file, from this device or (when online) from Google Drive. */
  const getBlob = useCallback(async (d: FileDoc): Promise<Blob> => {
    const local = await idb.getFile(d.id);
    if (local) return local;
    if (!d.driveId) throw new Error('This file was added on another device and hasn’t reached Google Drive yet. Open the app on that device while online.');
    if (!navigator.onLine) throw new Error('This document isn’t saved on this device yet. Connect to the internet once to download it.');
    if (!drive.hasValidToken()) throw new Error('Tap the sync status to sign in to Google again, then open the document.');
    setBusy(b => ({ ...b, [d.id]: 'down' }));
    try {
      const blob = await drive.downloadBlob(d.driveId);
      await idb.putFile(d.id, blob);
      refreshLocal();
      return blob;
    } finally { setBusy(b => { const n = { ...b }; delete n[d.id]; return n; }); }
  }, [refreshLocal]);

  const saveLocal = useCallback(async (id: string, blob: Blob) => { await idb.putFile(id, blob); refreshLocal(); }, [refreshLocal]);
  const removeLocal = useCallback(async (d: FileDoc) => {
    await idb.deleteFile(d.id);
    if (d.driveId) { writeTrash([...readTrash(), d.driveId]); run(); }
    refreshLocal();
  }, [refreshLocal, run]);

  return { localIds, busy, getBlob, saveLocal, removeLocal };
}
