// App updates via the service worker: the app itself is stored on the device (offline mode).
// When a newer version is published, it is downloaded in the background. Right after opening
// it is applied straight away; later on, a banner offers it so nothing in progress is lost.
// Pull-to-refresh calls `checkNow`, which applies a found update immediately.
import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

const startedAt = Date.now();

export function useUpdateCheck() {
  const [available, setAvailable] = useState(false);
  const apply = useRef<(reload?: boolean) => Promise<void>>(async () => location.reload());
  const reg = useRef<ServiceWorkerRegistration | null>(null);
  const applyWhenFound = useRef(false);

  useEffect(() => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
    apply.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        if (applyWhenFound.current || Date.now() - startedAt < 15_000) apply.current(true);
        else setAvailable(true);
      },
      onRegisteredSW(_url, r) {
        if (!r) return;
        reg.current = r;
        const check = () => { if (navigator.onLine) r.update().catch(() => {}); };
        setInterval(check, 5 * 60_000);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      },
    });
  }, []);

  /** Looks for a new version right now; if one is found it is installed and the app reloads. */
  const checkNow = async () => {
    const r = reg.current;
    if (!r || !navigator.onLine) return false;
    applyWhenFound.current = true;
    try { await r.update(); } catch { /* offline or server hiccup */ }
    if (r.waiting || r.installing) { if (r.waiting) apply.current(true); return true; }
    setTimeout(() => { applyWhenFound.current = false; }, 10_000);
    return false;
  };

  return { available, update: () => apply.current(true), checkNow };
}
