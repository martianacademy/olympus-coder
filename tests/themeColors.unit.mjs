// Unit tests: per-mode theme colors — a custom color set in dark stays dark's, light keeps its own;
// the legacy global accent/overrides migrate into the dark bucket once. File: src/shared/themes.ts.
// Run: node tests/themeColors.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
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

const { DEFAULT_THEME, migrateThemeColors, resolvePalette, THEME_PRESETS } = await import(`${APP}/src/shared/themes.ts`);

const dark = (t) => resolvePalette(t, true);
const light = (t) => resolvePalette(t, false);

const base = { ...DEFAULT_THEME, mode: 'system', preset: 'graphite' };
const graphiteDark = THEME_PRESETS[0].dark;
const graphiteLight = THEME_PRESETS[0].light;

// 1. Dark overrides apply in dark only
{
  const t = { ...base, overridesDark: { text: '#ffffff' }, accentDark: '#ff0000' };
  assert.equal(dark(t).palette.text, '#ffffff');
  assert.equal(dark(t).palette.accent, '#ff0000');
  assert.equal(light(t).palette.text, graphiteLight.text, 'light text stays the preset light color');
  assert.equal(light(t).palette.accent, graphiteLight.accent, 'light accent stays the preset light color');
}

// 2. Light overrides apply in light only
{
  const t = { ...base, overridesLight: { panel: '#112233' }, accentLight: '#00ff00' };
  assert.equal(light(t).palette.panel, '#112233');
  assert.equal(light(t).palette.accent, '#00ff00');
  assert.equal(dark(t).palette.panel, graphiteDark.panel, 'dark panel unaffected');
  assert.equal(dark(t).palette.accent, graphiteDark.accent, 'dark accent unaffected');
}

// 3. Mode 'system' follows the flag
{
  const t = { ...base, mode: 'system', overridesDark: { text: '#ffffff' }, overridesLight: { text: '#000000' } };
  assert.equal(dark(t).palette.text, '#ffffff');
  assert.equal(light(t).palette.text, '#000000');
}

// 4. Legacy global accent/overrides no longer leak across modes
{
  const t = { ...base, accent: '#ff0000', overrides: { text: '#ffffff' } };
  assert.equal(dark(t).palette.text, graphiteDark.text, 'legacy overrides ignored');
  assert.equal(dark(t).palette.accent, graphiteDark.accent, 'legacy accent ignored');
}

// 5. Empty buckets fall back to the preset
{
  const t = { ...base, overridesDark: {}, accentDark: undefined };
  assert.equal(dark(t).palette.text, graphiteDark.text);
  assert.equal(dark(t).palette.accent, graphiteDark.accent);
}

// 6. Migration moves the legacy global colors into the dark bucket once (and keeps per-mode values already there)
{
  const { theme, changed } = migrateThemeColors({ ...base, accent: '#ff0000', overrides: { text: '#ffffff' } });
  assert.equal(changed, true);
  assert.equal(theme.accentDark, '#ff0000');
  assert.deepEqual(theme.overridesDark, { text: '#ffffff' });
  assert.equal(theme.accent, undefined, 'legacy accent cleared');
  assert.deepEqual(theme.overrides, {}, 'legacy overrides cleared');
  assert.equal(dark(theme).palette.text, '#ffffff');
  assert.equal(dark(theme).palette.accent, '#ff0000');
  assert.equal(light(theme).palette.text, graphiteLight.text, 'light keeps its preset color after migration');
}
{
  const { theme, changed } = migrateThemeColors({ ...base, overrides: { text: '#ffffff' }, overridesDark: { bg: '#123456' } });
  assert.equal(changed, true);
  // Existing per-mode values win; the legacy ones fill the rest of the dark bucket.
  assert.deepEqual(theme.overridesDark, { text: '#ffffff', bg: '#123456' });
}

// 7. Nothing to migrate → unchanged, not marked changed
{
  const input = { ...base };
  const { theme, changed } = migrateThemeColors(input);
  assert.equal(changed, false);
  assert.equal(theme, input, 'same object handed back, nothing copied or touched');
  const withEmpty = migrateThemeColors({ ...base, overrides: {} });
  assert.equal(withEmpty.changed, false);
}

// 8. Defaults ship without custom colors
assert.deepEqual(DEFAULT_THEME.overrides, {});
assert.equal(DEFAULT_THEME.accentDark, undefined);
assert.equal(DEFAULT_THEME.overridesDark, undefined);

console.log('themeColors.unit OK');
