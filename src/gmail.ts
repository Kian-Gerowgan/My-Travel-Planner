// Read-only Gmail access for the assistant. Uses its own Google sign-in (scope gmail.readonly),
// separate from Drive, so Drive sync keeps working even if Gmail access is never granted.
import { GOOGLE_CLIENT_ID, loadGoogleSignIn } from './drive';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_KEY = 'mtp:gmailtoken';

type Token = { token: string; exp: number };
let token: Token | null = (() => {
  try { const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); return t && t.exp > Date.now() ? t : null; } catch { return null; }
})();

export const hasGmailToken = () => !!token && token.exp > Date.now() + 60_000;
export class GmailAuthError extends Error {}

/** Opens Google's sign-in popup for Gmail (read only). Must run from a click handler. */
export async function connectGmail(): Promise<void> {
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
      error_callback: (e: any) => reject(new Error(e?.type === 'popup_closed' ? 'The Google sign-in window was closed.' : 'Google sign-in for Gmail failed.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function disconnectGmail() {
  const t = token;
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  try { if (t) (window as any).google?.accounts?.oauth2?.revoke(t.token, () => {}); } catch { /* ignore */ }
}

async function call(path: string) {
  if (!hasGmailToken()) throw new GmailAuthError('Gmail is not connected (or the sign-in expired).');
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token!.token}` } });
  if (res.status === 401) { disconnectGmail(); throw new GmailAuthError('Gmail sign-in expired.'); }
  if (!res.ok) throw new Error(`Gmail answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const header = (m: any, name: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function b64urlToText(data: string) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
export const b64urlToB64 = (data: string) => {
  const s = data.replace(/-/g, '+').replace(/_/g, '/');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
};

function walk(part: any, out: { text: string[]; html: string[]; files: any[] }) {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) out.files.push({ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body.size });
  else if (part.mimeType === 'text/plain' && part.body?.data) out.text.push(b64urlToText(part.body.data));
  else if (part.mimeType === 'text/html' && part.body?.data) out.html.push(b64urlToText(part.body.data));
  (part.parts || []).forEach((p: any) => walk(p, out));
}

function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style,script').forEach(n => n.remove());
  doc.querySelectorAll('br,p,div,tr,li,h1,h2,h3,h4,table').forEach(n => n.append('\n'));
  doc.querySelectorAll('td,th').forEach(n => n.append(' | '));
  return (doc.body.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

export async function searchMail(query: string, max = 15) {
  const list = await call(`/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(max, 30)}`);
  const ids: string[] = (list.messages || []).map((m: any) => m.id);
  return Promise.all(ids.map(async id => {
    const m = await call(`/messages/${id}?format=full`);
    const out = { text: [] as string[], html: [] as string[], files: [] as any[] };
    walk(m.payload, out);
    return { id, date: header(m, 'Date'), from: header(m, 'From'), subject: header(m, 'Subject'), snippet: m.snippet, attachments: out.files.map(f => f.filename) };
  }));
}

export async function readMail(id: string) {
  const m = await call(`/messages/${id}?format=full`);
  const out = { text: [] as string[], html: [] as string[], files: [] as any[] };
  walk(m.payload, out);
  const body = out.text.join('\n').trim() || htmlToText(out.html.join('\n'));
  return {
    id, date: header(m, 'Date'), from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'),
    body: body.length > 40000 ? body.slice(0, 40000) + '\n[… truncated]' : body,
    attachments: out.files.map(f => ({ filename: f.filename, mimeType: f.mimeType, size: f.size })),
  };
}

/** Returns an attachment (found by file name, since Gmail's attachment ids change between reads) as standard base64. */
export async function getAttachment(messageId: string, filename: string) {
  const m = await call(`/messages/${messageId}?format=full`);
  const out = { text: [] as string[], html: [] as string[], files: [] as any[] };
  walk(m.payload, out);
  const f = out.files.find(x => x.filename === filename) || out.files.find(x => x.filename.toLowerCase() === filename.toLowerCase());
  if (!f) throw new Error(`No attachment named "${filename}" in this e-mail. Attachments: ${out.files.map(x => x.filename).join(', ') || 'none'}`);
  const a = await call(`/messages/${messageId}/attachments/${encodeURIComponent(f.attachmentId)}`);
  return { b64: b64urlToB64(a.data), mime: f.mimeType as string, filename: f.filename as string, size: f.size as number };
}

export function base64ToBlob(b64: string, mime: string) {
  const bin = atob(b64);
  return new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))], { type: mime || 'application/octet-stream' });
}
