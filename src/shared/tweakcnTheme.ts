/**
 * Pure parser and generator for standard Tailwind / shadcn / tweakcn `globals.css` themes.
 *
 * Parses `:root { ... }` (light) and `.dark { ... }` (dark) CSS custom properties—supporting
 * `oklch()`, `hsl()`, `rgb()`, `#hex`, and legacy shadcn v3 bare HSL triplets (`240 10% 3.9%`)—
 * and maps them cleanly onto Olympus Coder's palette, radius, fonts, and shadows while
 * rejecting unsafe CSS constructs (`url()`, `@import`, `expression()`).
 */

import type { ThemePalette, ThemeSettings } from './types';
import { DEFAULT_THEME, THEME_PRESETS } from './themes';

export interface ParsedTweakcnMode {
  palette: Partial<ThemePalette>;
  radius?: number;
  uiFont?: string;
  codeFont?: string;
  shadows: Partial<Record<'sm' | 'md' | 'lg', string>>;
  /** Sanitized raw `--*` declarations (e.g. `--background`, `--primary`, `--sidebar`) for `:root`. */
  vars: Record<string, string>;
}

export interface ParsedTweakcnTheme {
  light: ParsedTweakcnMode;
  dark: ParsedTweakcnMode;
  lightCount: number;
  darkCount: number;
  hasAny: boolean;
}

const UNSAFE_VALUE = /url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|[{}<>]/i;
const BARE_HSL = /^\d+(?:\.\d+)?(?:deg|rad|grad|turn)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%(?:\s*\/\s*[\d.]+%?)?$/i;

/** Returns a safe CSS value string or null if it looks malicious/malformed. */
function sanitizeValue(raw: string): string | null {
  const cleaned = raw.replace(/\s*!important\s*$/i, '').trim();
  if (!cleaned || cleaned.length > 300 || UNSAFE_VALUE.test(cleaned)) return null;
  return cleaned;
}

/** Wraps legacy shadcn v3 bare HSL triplets (`240 5.9% 10%`) in `hsl(...)`; keeps modern color functions intact. */
function normalizeColor(val: string): string {
  return BARE_HSL.test(val) ? `hsl(${val})` : val;
}

/** Parses `--radius` (`0.5rem`, `0.625rem`, `10px`) into px clamped to `0–20`. */
function parseRadiusPx(val: string): number | undefined {
  const rem = /^(-?\d+(?:\.\d+)?)rem$/i.exec(val);
  if (rem) return Math.max(0, Math.min(20, Math.round(Number(rem[1]) * 16)));
  const px = /^(-?\d+(?:\.\d+)?)px$/i.exec(val);
  if (px) return Math.max(0, Math.min(20, Math.round(Number(px[1]))));
  if (val === '0') return 0;
  return undefined;
}

/** Extracts `--name: value;` pairs from a single CSS declaration block body. */
function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    if (!/^--[a-z0-9-]+$/.test(key)) continue;
    const val = sanitizeValue(part.slice(idx + 1));
    if (val) out[key] = val;
  }
  return out;
}

/** Maps a bag of Tailwind/tweakcn CSS variables onto Olympus Coder tokens. */
function mapVarsToMode(vars: Record<string, string>): ParsedTweakcnMode {
  const pickColor = (...names: string[]): string | undefined => {
    for (const n of names) {
      if (vars[n]) return normalizeColor(vars[n]);
    }
    return undefined;
  };

  const isShadcn = Boolean(vars['--background'] || vars['--foreground'] || vars['--primary'] || vars['--card']);
  const palette: Partial<ThemePalette> = {};
  const bg = pickColor('--background', '--bg');
  const panel = pickColor('--sidebar', '--sidebar-background', '--panel', '--secondary', '--muted');
  const surface = pickColor('--card', '--popover', '--surface', '--background');
  const border = pickColor('--border', '--input');
  const text = pickColor('--foreground', '--card-foreground', '--text');
  // In shadcn/tweakcn, `--muted` is a background surface and `--accent` is a hover surface;
  // only fall back to them when parsing non-shadcn Olympus-native CSS.
  const muted = isShadcn ? pickColor('--muted-foreground') : pickColor('--muted-foreground', '--muted');
  const accent = isShadcn ? pickColor('--primary') : pickColor('--primary', '--accent');
  const accentText = pickColor('--primary-foreground', '--accent-foreground', '--accent-text');
  const danger = pickColor('--destructive', '--danger');
  const success = pickColor('--success');
  const warning = pickColor('--warning');
  const code = pickColor('--muted', '--secondary', '--code', '--accent');

  if (bg) palette.bg = bg;
  if (panel) palette.panel = panel;
  if (surface) palette.surface = surface;
  if (border) palette.border = border;
  if (text) palette.text = text;
  if (muted) palette.muted = muted;
  if (accent) palette.accent = accent;
  if (accentText) palette.accentText = accentText;
  if (danger) palette.danger = danger;
  if (success) palette.success = success;
  if (warning) palette.warning = warning;
  if (code) palette.code = code;

  const radius = vars['--radius'] ? parseRadiusPx(vars['--radius']) : undefined;
  const uiFont = vars['--font-sans'];
  const codeFont = vars['--font-mono'];
  const shadows: Partial<Record<'sm' | 'md' | 'lg', string>> = {};
  if (vars['--shadow-sm']) shadows.sm = vars['--shadow-sm'];
  if (vars['--shadow-md']) shadows.md = vars['--shadow-md'];
  if (vars['--shadow-lg']) shadows.lg = vars['--shadow-lg'];

  const normalizedVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    normalizedVars[k] = BARE_HSL.test(v) ? `hsl(${v})` : v;
  }

  return { palette, radius, uiFont, codeFont, shadows, vars: normalizedVars };
}

/**
 * Parses a standard Tailwind / shadcn / tweakcn `globals.css` string into light (`:root`) and
 * dark (`.dark` / `[data-theme="dark"]`) mode token sets.
 */
export function parseTweakcnCss(css: string): ParsedTweakcnTheme {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const lightRaw: Record<string, string> = {};
  const darkRaw: Record<string, string> = {};

  // Match top-level selector blocks (skipping `@theme` blocks which only reference `var(...)`).
  const blockRe = /([^{}@]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let matchedBlock = false;
  while ((m = blockRe.exec(stripped)) !== null) {
    const sel = m[1].trim();
    const body = m[2];
    if (!sel || sel.startsWith('@')) continue;
    const isDark = /(?:^|[\s,])(?:\.dark|\[data-theme\s*=\s*['"]?dark['"]?\])(?:$|[\s,:])/i.test(sel);
    const isLight = /(?:^|[\s,])(?::root|\.light|\[data-theme\s*=\s*['"]?light['"]?\])(?:$|[\s,:])/i.test(sel);
    if (!isDark && !isLight) continue;
    matchedBlock = true;
    const decls = parseDeclarations(body);
    if (isDark) Object.assign(darkRaw, decls);
    if (isLight) Object.assign(lightRaw, decls);
  }

  // Convenience: if user pasted bare `--background: ...;` lines without a `:root { }` wrapper, accept them as both modes.
  if (!matchedBlock) {
    const bare = parseDeclarations(stripped);
    if (Object.keys(bare).length > 0) {
      Object.assign(lightRaw, bare);
      Object.assign(darkRaw, bare);
    }
  }

  const light = mapVarsToMode(lightRaw);
  // Dark inherits shared non-color vars (radius, fonts) from :root if .dark omits them.
  const mergedDarkRaw: Record<string, string> = {};
  for (const k of ['--radius', '--font-sans', '--font-mono', '--shadow-sm', '--shadow-md', '--shadow-lg']) {
    if (lightRaw[k] && !darkRaw[k]) mergedDarkRaw[k] = lightRaw[k];
  }
  Object.assign(mergedDarkRaw, darkRaw);
  const dark = mapVarsToMode(mergedDarkRaw);

  const lightCount = Object.keys(lightRaw).length;
  const darkCount = Object.keys(darkRaw).length;
  return { light, dark, lightCount, darkCount, hasAny: lightCount > 0 || darkCount > 0 };
}

/** Formats a single mode's Olympus palette as standard Tailwind / shadcn / tweakcn CSS variables. */
function formatModeBlock(pal: ThemePalette, radiusPx: number, uiFont: string, codeFont: string): string {
  const radiusRem = `${Number((radiusPx / 16).toFixed(3))}rem`;
  return [
    `  --background: ${pal.bg};`,
    `  --foreground: ${pal.text};`,
    `  --card: ${pal.surface};`,
    `  --card-foreground: ${pal.text};`,
    `  --popover: ${pal.surface};`,
    `  --popover-foreground: ${pal.text};`,
    `  --primary: ${pal.accent};`,
    `  --primary-foreground: ${pal.accentText};`,
    `  --secondary: ${pal.code};`,
    `  --secondary-foreground: ${pal.text};`,
    `  --muted: ${pal.code};`,
    `  --muted-foreground: ${pal.muted};`,
    `  --accent: ${pal.code};`,
    `  --accent-foreground: ${pal.text};`,
    `  --destructive: ${pal.danger};`,
    `  --destructive-foreground: #ffffff;`,
    `  --border: ${pal.border};`,
    `  --input: ${pal.border};`,
    `  --ring: ${pal.accent};`,
    `  --sidebar: ${pal.panel};`,
    `  --sidebar-foreground: ${pal.text};`,
    `  --sidebar-primary: ${pal.accent};`,
    `  --sidebar-primary-foreground: ${pal.accentText};`,
    `  --sidebar-border: ${pal.border};`,
    `  --radius: ${radiusRem};`,
    `  --font-sans: ${uiFont};`,
    `  --font-mono: ${codeFont};`,
  ].join('\n');
}

/**
 * Exports an Olympus Coder theme (active preset + per-mode overrides) as standard
 * Tailwind v4 / shadcn / tweakcn `globals.css` (`:root` + `.dark`) so users can edit
 * any variable directly or copy it to/from tweakcn.com.
 */
export function themeToTweakcnCss(theme: ThemeSettings, uiFontCss: string, codeFontCssStr: string): string {
  const t: ThemeSettings = { ...DEFAULT_THEME, ...theme };
  const preset = THEME_PRESETS.find((p) => p.id === t.preset) ?? THEME_PRESETS[0];
  const lightPal: ThemePalette = {
    ...preset.light,
    ...(t.accentLight ? { accent: t.accentLight } : {}),
    ...(t.overridesLight ?? {}),
  };
  const darkPal: ThemePalette = {
    ...preset.dark,
    ...(t.accentDark ? { accent: t.accentDark } : {}),
    ...(t.overridesDark ?? {}),
  };
  const radius = t.radius ?? DEFAULT_THEME.radius;
  return [
    `/* Standard Tailwind / shadcn / tweakcn globals.css — paste any theme from tweakcn.com */`,
    `:root {`,
    formatModeBlock(lightPal, radius, uiFontCss, codeFontCssStr),
    `}`,
    ``,
    `.dark {`,
    formatModeBlock(darkPal, radius, uiFontCss, codeFontCssStr),
    `}`,
    ``,
  ].join('\n');
}
