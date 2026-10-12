// Detects a newly published version: GitHub Pages lets browsers cache index.html for a while
// (iOS home-screen apps even longer), so the app asks for a fresh copy and compares the
// script it references with the one currently running.
import { useEffect, useState } from 'react';

const currentScript = () => (document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null)?.getAttribute('src') || '';

async function latestScript(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}index.html?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.text()).match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/)?.[1] || null;
  } catch { return null; }
}

// A plain reload can be served from the same cache again; a fresh URL can't.
const reloadFresh = () => location.replace(`${import.meta.env.BASE_URL}?v=${Date.now()}${location.hash}`);
const TRIED_KEY = 'mtp:update-tried';

export function useUpdateCheck() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const mine = currentScript();
    let first = true;
    const check = async () => {
      const latest = await latestScript();
      if (!latest || !mine || latest === mine) return;
      // Right after opening, nothing is in progress yet: update straight away (once per version, to avoid loops).
      let tried = '';
      try { tried = sessionStorage.getItem(TRIED_KEY) || ''; sessionStorage.setItem(TRIED_KEY, latest); } catch { /* storage unavailable */ }
      if (first && tried !== latest) { reloadFresh(); return; }
      setAvailable(true);
    };
    check().finally(() => { first = false; });
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(check, 5 * 60_000);
    return () => { document.removeEventListener('visibilitychange', onVisible); clearInterval(t); };
  }, []);
  return { available, update: reloadFresh };
}
