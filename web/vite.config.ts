import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Живём под https://inshinlab.com/swapforge/ — nginx режет префикс перед бэкендом
  base: '/swapforge/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(here, '../shared'),
    },
  },
  server: {
    port: 5195,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: {
      '/swapforge/api': {
        target: 'http://127.0.0.1:4315',
        rewrite: (p) => p.replace(/^\/swapforge/, ''),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
