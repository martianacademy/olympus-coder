import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const { parseTweakcnCss, themeToTweakcnCss } = await import('../src/shared/tweakcnTheme.ts');
const { DEFAULT_THEME } = await import('../src/shared/themes.ts');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok   ${name}`);
}

test('parses real tweakcn oklch() :root and .dark blocks with @theme inline ignored', () => {
  const css = `
    :root {
      --background: oklch(0.98 0.01 95);
      --foreground: oklch(0.20 0.02 260);
      --card: oklch(1 0 0);
      --sidebar: oklch(0.95 0.01 95);
      --primary: oklch(0.58 0.19 255);
      --primary-foreground: oklch(0.99 0 0);
      --muted: oklch(0.93 0.01 95);
      --muted-foreground: oklch(0.50 0.02 260);
      --border: oklch(0.88 0.01 95);
      --destructive: oklch(0.57 0.22 27);
      --radius: 0.75rem;
      --font-sans: "Plus Jakarta Sans", sans-serif;
      --font-mono: "Fira Code", monospace;
    }
    .dark {
      --background: oklch(0.14 0.02 260);
      --foreground: oklch(0.96 0.01 260);
      --card: oklch(0.18 0.02 260);
      --sidebar: oklch(0.11 0.02 260);
      --primary: oklch(0.68 0.18 255);
      --primary-foreground: oklch(0.12 0.02 260);
      --muted: oklch(0.22 0.02 260);
      --muted-foreground: oklch(0.68 0.02 260);
      --border: oklch(0.26 0.02 260);
      --destructive: oklch(0.62 0.21 25);
    }
    @theme inline {
      --color-background: var(--background);
    }
  `;
  const r = parseTweakcnCss(css);
  assert.equal(r.hasAny, true);
  assert.equal(r.lightCount, 13);
  assert.equal(r.darkCount, 10);
  assert.equal(r.light.palette.bg, 'oklch(0.98 0.01 95)');
  assert.equal(r.light.palette.panel, 'oklch(0.95 0.01 95)');
  assert.equal(r.light.palette.accent, 'oklch(0.58 0.19 255)');
  assert.equal(r.light.radius, 12);
  assert.equal(r.dark.palette.bg, 'oklch(0.14 0.02 260)');
  assert.equal(r.dark.radius, 12); // inherited from :root
  assert.equal(r.dark.uiFont, '"Plus Jakarta Sans", sans-serif');
  assert.equal(r.dark.codeFont, '"Fira Code", monospace');
});

test('normalizes legacy shadcn v3 bare HSL triplets', () => {
  const css = `:root { --background: 0 0% 100%; --foreground: 240 10% 3.9%; --primary: 240 5.9% 10%; --radius: 8px; }`;
  const r = parseTweakcnCss(css);
  assert.equal(r.light.palette.bg, 'hsl(0 0% 100%)');
  assert.equal(r.light.palette.text, 'hsl(240 10% 3.9%)');
  assert.equal(r.light.palette.accent, 'hsl(240 5.9% 10%)');
  assert.equal(r.light.radius, 8);
});

test('sanitizes unsafe values (url(), @import, expression) without breaking valid vars', () => {
  const css = `:root {
    --background: url(https://evil.example/a.png);
    --foreground: #ededf0;
    --primary: expression(alert(1));
    --border: #29292e;
  }`;
  const r = parseTweakcnCss(css);
  assert.equal(r.light.palette.bg, undefined);
  assert.equal(r.light.palette.accent, undefined);
  assert.equal(r.light.palette.text, '#ededf0');
  assert.equal(r.light.palette.border, '#29292e');
});

test('themeToTweakcnCss round-trips cleanly through parseTweakcnCss', () => {
  const css = themeToTweakcnCss(DEFAULT_THEME, '"Inter Variable", sans-serif', '"JetBrains Mono", monospace');
  const r = parseTweakcnCss(css);
  assert.equal(r.hasAny, true);
  assert.equal(r.light.palette.bg, '#fcfcfd');
  assert.equal(r.dark.palette.bg, '#151517');
  assert.equal(r.dark.palette.panel, '#0f0f11');
  assert.equal(r.dark.palette.accent, '#e2835f');
  assert.equal(r.light.radius, 10);
});

console.log(`\n${passed} passed, 0 failed`);
