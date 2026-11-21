/**
 * Builds the pure-Node headless Olympus Coder server (`out/server/index.mjs`) with zero Electron
 * dependency by aliasing `'electron'` to `src/server/electronShim.ts` while reusing 100% of
 * `src/main/*` handlers, ACP agent orchestration, files/Git/PTY APIs, and E2EE Cloudflare Relay.
 */
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  root,
  logLevel: 'info',
  resolve: {
    alias: {
      '@shared': resolve(root, 'src', 'shared'),
      electron: resolve(root, 'src', 'server', 'electronShim.ts'),
    },
  },
  build: {
    ssr: resolve(root, 'src', 'server', 'cli.ts'),
    outDir: resolve(root, 'out', 'server'),
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      external: [/^node:/, 'node-pty', 'qrcode', /^@agentclientprotocol\//],
      output: {
        format: 'es',
        entryFileNames: 'index.mjs',
        codeSplitting: false,
        banner: '#!/usr/bin/env node',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});

chmodSync(resolve(root, 'out', 'server', 'index.mjs'), 0o755);
console.log('✓ Built pure-Node headless server: out/server/index.mjs');
