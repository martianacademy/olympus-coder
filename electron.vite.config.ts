import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src', 'shared') } },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src', 'shared') } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src', 'shared') } },
    plugins: [react()],
    // Two pages: the desktop window, and the phone app the remote server serves (remote.html).
    build: {
      rollupOptions: {
        input: {
          index: resolve('src', 'renderer', 'index.html'),
          remote: resolve('src', 'renderer', 'remote.html'),
        },
      },
    },
  },
});
