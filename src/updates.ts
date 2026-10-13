// App updates via the service worker: the app itself is stored on the device (offline mode).
// When a newer version is published, it is downloaded in the background. Right after opening
// it is applied straight away; later on, a banner offers it so nothing in progress is lost.
import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

const startedAt = Date.now();

export function useUpdateCheck() {
  const [available, setAvailable] = useState(false);
  const apply = useRef<(reload?: boolean) => Promise<void>>(async () => location.reload());

  useEffect(() => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
    apply.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        if (Date.now() - startedAt < 15_000) apply.current(true);
        else setAvailable(true);
      },
      onRegisteredSW(_url, reg) {
        if (!reg) return;
        const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
        setInterval(check, 5 * 60_000);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      },
    });
  }, []);

  return { available, update: () => apply.current(true) };
}
