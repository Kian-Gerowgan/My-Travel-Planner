import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from https://kian-gerowgan.github.io/My-Travel-Planner/ on GitHub Pages
export default defineConfig({
  base: '/My-Travel-Planner/',
  plugins: [react()],
  server: { port: 5180, strictPort: true },
});
