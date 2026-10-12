// Thin Google Drive client for the browser: sign-in via Google Identity Services,
// file operations via the Drive v3 REST API. Uses the narrow `drive.file` scope,
// so the app can only see files and folders it created itself.

export const GOOGLE_CLIENT_ID = '667767558184-ulqiff1cnhnrhb2ib8vhhrclgm3tjr16.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'id,version,modifiedTime';
const TOKEN_KEY = 'mtp:gtoken';

export const ROOT_FOLDER = 'My Travel Planner';
export const BACKUP_FOLDER = 'Backups';
export const DATA_FILE = 'travel-data.json';

export interface DriveFile { id: string; version: string; modifiedTime: string; }
export class AuthError extends Error {}

/* ---------- Sign-in ---------- */
let gisPromise: Promise<void> | null = null;
export function loadGoogleSignIn() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Check your internet connection.')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

type Token = { token: string; exp: number };
let token: Token | null = (() => {
  try { const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); return t && t.exp > Date.now() ? t : null; } catch { return null; }
})();

export const hasValidToken = () => !!token && token.exp > Date.now() + 60_000;

function clearToken() {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

/** Opens Google's sign-in popup. Must be called from a click handler, or the browser blocks the popup. */
export async function signIn(firstTime: boolean): Promise<void> {
  const g = () => (window as any).google?.accounts?.oauth2;
  if (!g()) await loadGoogleSignIn();
  return new Promise((resolve, reject) => {
    const client = g().initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r: any) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        token = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch { /* storage unavailable */ }
        resolve();
      },
      error_callback: (e: any) => reject(new Error(e?.type === 'popup_closed' ? 'The Google sign-in window was closed.' : e?.type === 'popup_failed_to_open' ? 'The browser blocked the Google sign-in window. Allow pop-ups for this site.' : 'Google sign-in failed.')),
    });
    client.requestAccessToken({ prompt: firstTime ? 'consent' : '' });
  });
}

export function signOut() {
  const t = token;
  clearToken();
  try { if (t) (window as any).google?.accounts?.oauth2?.revoke(t.token, () => {}); } catch { /* ignore */ }
}

/* ---------- Drive REST ---------- */
async function call(url: string, init: RequestInit = {}) {
  if (!hasValidToken()) throw new AuthError('Google sign-in has expired.');
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token!.token}` } });
  if (res.status === 401) { clearToken(); throw new AuthError('Google sign-in has expired.'); }
  if (!res.ok) throw new Error(`Google Drive answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res;
}
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function findOne(query: string): Promise<DriveFile | null> {
  const url = `${API}/files?q=${encodeURIComponent(query + ' and trashed=false')}&fields=files(${FIELDS})&orderBy=createdTime&pageSize=1&spaces=drive`;
  const j = await (await call(url)).json();
  return j.files?.[0] || null;
}

export async function ensureFolder(name: string, parentId?: string): Promise<string> {
  const found = await findOne(`name='${esc(name)}' and mimeType='${FOLDER_MIME}'` + (parentId ? ` and '${parentId}' in parents` : ''));
  if (found) return found.id;
  const r = await call(`${API}/files?fields=id`, json({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined }));
  return (await r.json()).id;
}

export const findFile = (name: string, parentId: string) => findOne(`name='${esc(name)}' and '${parentId}' in parents`);

export async function getMeta(id: string): Promise<DriveFile> {
  return (await call(`${API}/files/${id}?fields=${FIELDS}`)).json();
}

export async function downloadJson(id: string): Promise<any> {
  return (await call(`${API}/files/${id}?alt=media`)).json();
}

export async function createJson(parentId: string, name: string, data: unknown): Promise<DriveFile> {
  const b = 'mtp' + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId], mimeType: 'application/json' })}\r\n`
    + `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data, null, 1)}\r\n--${b}--`;
  const r = await call(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  return r.json();
}

export async function updateJson(id: string, data: unknown): Promise<DriveFile> {
  const r = await call(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data, null, 1) });
  return r.json();
}

export async function copyFile(id: string, name: string, parentId: string) {
  await call(`${API}/files/${id}/copy?fields=id`, json({ name, parents: [parentId] }));
}
