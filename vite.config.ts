import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Served from https://kian-gerowgan.github.io/My-Travel-Planner/ on GitHub Pages.
// The service worker stores the whole app on the device, so it opens without internet
// (in flight, or in mainland China where Google and GitHub may be unreachable).
export default defineConfig({
  base: '/My-Travel-Planner/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'My Travel Planner',
        short_name: 'Travel Planner',
        description: 'Personal travel organizer: timeline, calendar, contacts and documents.',
        start_url: '/My-Travel-Planner/',
        scope: '/My-Travel-Planner/',
        display: 'standalone',
        background_color: '#0E1412',
        theme_color: '#0E1412',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,jpg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
  server: { port: 5180, strictPort: true },
});
