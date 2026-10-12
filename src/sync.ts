// Keeps the planner data in sync with `My Travel Planner/travel-data.json` in Google Drive.
// The device always keeps a full local copy, so the app works offline; Drive is the master.
// Concurrent edits are merged per trip/activity/contact against the last synced snapshot;
// when the same item changed on two devices, this device's version wins and the other
// version is saved first as a conflict backup in Drive, so nothing is lost.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as drive from './drive';

type Item = { id: string };
export interface SyncData { trips: Item[]; activities: Item[]; contacts: Item[]; documents?: Item[]; sample?: boolean; [k: string]: any }

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'needs-auth' | 'offline' | 'error';
export interface SyncState { status: SyncStatus; lastSync?: number; error?: string; }
export type FirstChoice = 'empty' | 'upload';

interface Meta {
  connected: boolean;
  folderId?: string; backupsId?: string; fileId?: string;
  baseVersion?: string; base?: SyncData;
  lastSync?: number; lastBackupDay?: string;
}

const META_KEY = 'mtp:sync:v1';
const loadMeta = (): Meta => { try { return JSON.parse(localStorage.getItem(META_KEY) || '') || { connected: false }; } catch { return { connected: false }; } };
const saveMeta = (m: Meta) => { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* storage unavailable */ } };

const strip = (d: SyncData): SyncData => ({ version: d.version, trips: d.trips || [], activities: d.activities || [], contacts: d.contacts || [], documents: d.documents || [] });
const canon = (d?: SyncData) => (d ? JSON.stringify([d.trips, d.activities, d.contacts, d.documents || []]) : '');
const EMPTY: SyncData = { trips: [], activities: [], contacts: [], documents: [] };
const today = () => new Date().toISOString().slice(0, 10);

function mergeList(base: Item[], local: Item[], remote: Item[]) {
  const b = new Map(base.map(x => [x.id, x])), l = new Map(local.map(x => [x.id, x])), r = new Map(remote.map(x => [x.id, x]));
  const order = [...remote.map(x => x.id), ...local.map(x => x.id).filter(id => !r.has(id))];
  const out: Item[] = [];
  let conflicts = 0;
  for (const id of order) {
    const bi = b.get(id), li = l.get(id), ri = r.get(id);
    const lChanged = JSON.stringify(li) !== JSON.stringify(bi);
    const rChanged = JSON.stringify(ri) !== JSON.stringify(bi);
    let pick = ri;
    if (lChanged && !rChanged) pick = li;
    else if (lChanged && rChanged && JSON.stringify(li) !== JSON.stringify(ri)) { pick = li ?? ri; conflicts++; }
    if (pick) out.push(pick);
  }
  return { list: out, conflicts };
}

function merge(base: SyncData, local: SyncData, remote: SyncData) {
  const t = mergeList(base.trips, local.trips, remote.trips);
  const a = mergeList(base.activities, local.activities, remote.activities);
  const c = mergeList(base.contacts, local.contacts, remote.contacts);
  const d = mergeList(base.documents || [], local.documents || [], remote.documents || []);
  return { data: { ...strip(remote), trips: t.list, activities: a.list, contacts: c.list, documents: d.list }, conflicts: t.conflicts + a.conflicts + c.conflicts + d.conflicts };
}

export function useDriveSync(data: SyncData, replaceData: (d: SyncData) => void) {
  const meta = useRef<Meta>(loadMeta());
  const dataRef = useRef(data);
  dataRef.current = data;
  const busy = useRef(false);
  const again = useRef(false);
  const [state, setState] = useState<SyncState>(() => ({ status: meta.current.connected ? (drive.hasValidToken() ? 'idle' : 'needs-auth') : 'off', lastSync: meta.current.lastSync }));
  const [choice, setChoice] = useState<null | ((c: FirstChoice) => void)>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pending = meta.current.connected && canon(data) !== canon(meta.current.base);

  const askFirstChoice = () => new Promise<FirstChoice>(resolve => setChoice(() => (c: FirstChoice) => { setChoice(null); resolve(c); }));

  const backup = async (m: Meta, name: string) => {
    if (m.fileId && m.backupsId) await drive.copyFile(m.fileId, name, m.backupsId);
  };

  const run = useCallback(async (interactive = false) => {
    const m = meta.current;
    if (!m.connected) return;
    if (busy.current) { again.current = true; return; }
    if (!navigator.onLine) { setState(s => ({ ...s, status: 'offline' })); return; }
    if (!drive.hasValidToken()) {
      if (!interactive) { setState(s => ({ ...s, status: 'needs-auth' })); return; }
      try { await drive.signIn(false); } catch (e: any) { setState(s => ({ ...s, status: 'needs-auth', error: e.message })); return; }
    }
    busy.current = true;
    setState(s => ({ ...s, status: 'syncing' }));
    try {
      if (!m.folderId) m.folderId = await drive.ensureFolder(drive.ROOT_FOLDER);
      if (!m.backupsId) m.backupsId = await drive.ensureFolder(drive.BACKUP_FOLDER, m.folderId);
      if (!m.fileId) m.fileId = (await drive.findFile(drive.DATA_FILE, m.folderId))?.id;

      const local = dataRef.current;
      let result: SyncData;
      if (!m.fileId) {
        // First device to connect: create the data file in Drive.
        let start = strip(local);
        if (local.sample) start = (await askFirstChoice()) === 'empty' ? { ...strip(local), ...EMPTY } : strip(local);
        const f = await drive.createJson(m.folderId, drive.DATA_FILE, start);
        m.fileId = f.id; m.baseVersion = f.version; m.lastBackupDay = today();
        result = start;
        replaceData({ ...dataRef.current, ...start, sample: false });
      } else {
        const remoteMeta = await drive.getMeta(m.fileId);
        if (remoteMeta.version === m.baseVersion) {
          if (canon(local) !== canon(m.base)) {
            if (m.lastBackupDay !== today()) { await backup(m, `travel-data-${today()}.json`); m.lastBackupDay = today(); }
            m.baseVersion = (await drive.updateJson(m.fileId, strip(local))).version;
          }
          result = strip(local);
        } else {
          const remote = strip(await drive.downloadJson(m.fileId));
          let merged: SyncData, conflicts = 0;
          if (!m.base) ({ data: merged, conflicts } = local.sample ? { data: remote, conflicts: 0 } : merge(EMPTY, local, remote));
          else ({ data: merged, conflicts } = merge(m.base, local, remote));
          if (canon(merged) !== canon(remote)) {
            if (conflicts) await backup(m, `travel-data-conflict-${new Date().toISOString().slice(0, 16).replace(':', '-')}.json`);
            else if (m.lastBackupDay !== today()) { await backup(m, `travel-data-${today()}.json`); m.lastBackupDay = today(); }
            m.baseVersion = (await drive.updateJson(m.fileId, merged)).version;
          } else m.baseVersion = remoteMeta.version;
          result = merged;
          // Keep edits made while this sync was running.
          const now = dataRef.current;
          const apply = now === local ? merged : merge(strip(local), now, merged).data;
          if (canon(apply) !== canon(now)) replaceData({ ...now, ...apply, sample: false });
          if (conflicts) setNotice(`${conflicts} item${conflicts === 1 ? ' was' : 's were'} changed on two devices. This device’s version was kept; the other is saved in Drive › Backups.`);
        }
      }
      m.base = result; m.lastSync = Date.now();
      saveMeta(m);
      setState({ status: 'idle', lastSync: m.lastSync });
    } catch (e: any) {
      saveMeta(m);
      if (e instanceof drive.AuthError) setState(s => ({ ...s, status: 'needs-auth' }));
      else if (!navigator.onLine) setState(s => ({ ...s, status: 'offline' }));
      else setState(s => ({ ...s, status: 'error', error: e.message || String(e) }));
    } finally {
      busy.current = false;
      if (again.current) { again.current = false; setTimeout(() => run(false), 300); }
    }
  }, [replaceData]);

  /** Click handler: first-time connection to Google Drive. */
  const connect = useCallback(async () => {
    try {
      await drive.signIn(true);
    } catch (e: any) { setState({ status: 'off', error: e.message }); return; }
    meta.current = { connected: true };
    saveMeta(meta.current);
    await run(true);
  }, [run]);

  const disconnect = useCallback(() => {
    drive.signOut();
    meta.current = { connected: false };
    saveMeta(meta.current);
    setState({ status: 'off' });
  }, []);

  // Preload Google sign-in so the popup opens straight from a tap.
  useEffect(() => { drive.loadGoogleSignIn().catch(() => {}); }, []);

  // Sync on start, when the app comes back to the foreground, when the connection returns, and every minute.
  useEffect(() => {
    run(false);
    const onVisible = () => { if (document.visibilityState === 'visible') run(false); };
    const onOnline = () => run(false);
    const onOffline = () => setState(s => (s.status === 'off' ? s : { ...s, status: 'offline' }));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const t = setInterval(() => { if (document.visibilityState === 'visible') run(false); }, 60_000);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); clearInterval(t); };
  }, [run]);

  // Upload shortly after local changes.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => run(false), 2500);
    return () => clearTimeout(t);
  }, [data, pending, run]);

  return useMemo(() => ({
    ...state, pending, connected: meta.current.connected, folderId: meta.current.folderId,
    syncNow: () => run(true), connect, disconnect,
    choice, notice, clearNotice: () => setNotice(null),
  }), [state, pending, run, connect, disconnect, choice, notice]);
}
