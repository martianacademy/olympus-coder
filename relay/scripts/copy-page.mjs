// Copies the built phone page (out/renderer) into relay/public, marked as the relay version.
// Run after `npx electron-vite build` in the app folder.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../../out/renderer');
const out = join(here, '../public');
if (!existsSync(join(src, 'remote.html'))) throw new Error('Build the app first (npx electron-vite build): out/renderer/remote.html is missing.');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

let html = readFileSync(join(src, 'remote.html'), 'utf8');
html = html
  .replace('<head>', '<head>\n    <meta name="olympus-relay" content="1" />')
  // The page talks to the relay over a WebSocket on the same host.
  .replace("connect-src 'self'", "connect-src 'self' wss: ws:");
writeFileSync(join(out, 'index.html'), html);

for (const f of ['remote-sw.js', 'remote.webmanifest', 'remote-icon-192.png', 'remote-icon-512.png']) cpSync(join(src, f), join(out, f));

// Only the files the phone page loads (its entry, the chunks it imports, its CSS and fonts) — not the desktop app.
const assets = readdirSync(join(src, 'assets'));
const need = new Set();
const visit = (name) => {
  if (need.has(name) || !assets.includes(name)) return;
  need.add(name);
  if (!/\.(js|css)$/.test(name)) return;
  const text = readFileSync(join(src, 'assets', name), 'utf8');
  for (const m of text.matchAll(/[\w.@-]+\.(?:js|css|woff2?|ttf|png|svg|webp|jpe?g)/g)) visit(m[0]);
};
for (const m of html.matchAll(/assets\/([\w.@-]+)/g)) visit(m[1]);
for (const n of need) cpSync(join(src, 'assets', n), join(out, 'assets', n));

writeFileSync(
  join(out, '_headers'),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
);
console.log(`Phone page copied: ${need.size} asset files.`);
