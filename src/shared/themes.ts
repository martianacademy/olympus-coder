import type { ChatWidth, EditorSyntaxTheme, StepsSize, ThemePalette, ThemeSettings } from './types';

export interface ThemePreset {
  id: string;
  name: string;
  light: ThemePalette;
  dark: ThemePalette;
}

const base = {
  danger: '#e5484d',
  success: '#30a46c',
  warning: '#f5a524',
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    light: { ...base, bg: '#fcfcfd', panel: '#f3f3f5', surface: '#ffffff', border: '#e6e6ea', text: '#17171a', muted: '#6e6e7a', accent: '#d0663f', accentText: '#ffffff', code: '#f4f4f7' },
    dark: { ...base, bg: '#151517', panel: '#0f0f11', surface: '#1c1c1f', border: '#29292e', text: '#ededf0', muted: '#8b8b96', accent: '#e2835f', accentText: '#170b06', code: '#212125' },
  },
  {
    id: 'mars',
    name: 'Mars',
    light: { ...base, bg: '#fbf6f2', panel: '#f4ebe4', surface: '#ffffff', border: '#ecdcd0', text: '#2a1a12', muted: '#7d6658', accent: '#c4441c', accentText: '#ffffff', code: '#f6ece5' },
    dark: { ...base, bg: '#1b1210', panel: '#140d0b', surface: '#241815', border: '#3a2620', text: '#f6e9e2', muted: '#b39486', accent: '#ff6a3d', accentText: '#1b0f0b', code: '#2c1d19' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    light: { ...base, bg: '#f4f8fb', panel: '#e9f0f6', surface: '#ffffff', border: '#d6e2ec', text: '#0f2233', muted: '#5a7186', accent: '#1f7ae0', accentText: '#ffffff', code: '#edf3f8' },
    dark: { ...base, bg: '#0d1620', panel: '#09111a', surface: '#132130', border: '#1f3347', text: '#e3eef8', muted: '#8aa3b8', accent: '#4ea1ff', accentText: '#06111c', code: '#172736' },
  },
  {
    id: 'forest',
    name: 'Forest',
    light: { ...base, bg: '#f5f8f4', panel: '#eaf0e8', surface: '#ffffff', border: '#d8e3d4', text: '#14241a', muted: '#5d7363', accent: '#2f8a4e', accentText: '#ffffff', code: '#eef3ec' },
    dark: { ...base, bg: '#101812', panel: '#0b120d', surface: '#16211a', border: '#243429', text: '#e4efe6', muted: '#8fa796', accent: '#4cc27a', accentText: '#07140c', code: '#1a281f' },
  },
  {
    id: 'violet',
    name: 'Violet',
    light: { ...base, bg: '#f8f6fc', panel: '#efebf8', surface: '#ffffff', border: '#e0d9f0', text: '#1e1830', muted: '#6c6485', accent: '#7c4dff', accentText: '#ffffff', code: '#f1edf9' },
    dark: { ...base, bg: '#15121f', panel: '#100d18', surface: '#1d1929', border: '#2e2840', text: '#ece8f8', muted: '#a39cba', accent: '#a585ff', accentText: '#140d26', code: '#231e33' },
  },
  {
    id: 'mono',
    name: 'Mono',
    light: { ...base, bg: '#ffffff', panel: '#f5f5f5', surface: '#ffffff', border: '#e5e5e5', text: '#0a0a0a', muted: '#737373', accent: '#0a0a0a', accentText: '#ffffff', code: '#f5f5f5' },
    dark: { ...base, bg: '#0a0a0a', panel: '#000000', surface: '#141414', border: '#262626', text: '#fafafa', muted: '#a3a3a3', accent: '#fafafa', accentText: '#0a0a0a', code: '#1a1a1a' },
  },
];

export const DEFAULT_THEME: ThemeSettings = {
  preset: 'graphite',
  mode: 'system',
  overrides: {},
  fontSize: 14,
  uiFont: 'inter',
  codeFont: 'JetBrains Mono',
  radius: 10,
  density: 'comfortable',
  textWeight: 400,
  boldWeight: 600,
  chatFontSize: 0,
  lineHeight: 1.65,
  codeFontSize: 12.5,
  thinkingItalic: true,
  thinkingOpacity: 70,
  thinkingSize: 95,
  stepsSize: 'default',
  chatWidth: 'default',
  sidebarProjectGap: 2,
  sidebarRowGap: 0,
  sidebarFontSize: 0,
  editorFontFamily: '',
  editorFontSize: 0,
  editorFontWeight: 400,
  editorLineHeight: 1.55,
  editorLetterSpacing: 0,
  editorLigatures: true,
  editorSyntaxTheme: 'auto',
  editorSurface: 'surface',
  editorLineNumbers: 'on',
  editorFoldGutter: true,
  editorActiveLine: 'both',
  editorIndentGuides: true,
  editorRulerColumn: 0,
  editorRenderWhitespace: 'none',
  editorBracketMatching: true,
  editorSelectionMatch: true,
  editorScrollPastEnd: false,
  editorCursorStyle: 'line',
  editorCursorWidth: 2,
  editorCursorBlink: 'blink',
  editorTabSize: 2,
  editorIndentWithTabs: false,
  editorAutoCloseBrackets: true,
  editorTrimTrailingWhitespace: false,
  editorFinalNewline: false,
  terminalFontSize: 0,
  terminalLineHeight: 1.25,
  terminalCursorStyle: 'bar',
  terminalCursorBlink: true,
  terminalScrollback: 10000,
};

/** Steps text size as a factor of the chat text (Default = 13px rows next to 14px chat text). */
export const STEPS_SIZES: { id: StepsSize; name: string; scale: number }[] = [
  { id: 'smaller', name: 'Smaller', scale: 0.92 },
  { id: 'default', name: 'Default', scale: 1 },
  { id: 'larger', name: 'Larger', scale: 1.12 },
  { id: 'largest', name: 'Largest', scale: 1.25 },
];

/** Max width of the chat column, composer, pills and banners. */
export const CHAT_WIDTHS: { id: ChatWidth; name: string; px: number }[] = [
  { id: 'narrow', name: 'Narrow', px: 680 },
  { id: 'default', name: 'Default', px: 780 },
  { id: 'wide', name: 'Wide', px: 960 },
];

export const UI_FONTS: { id: string; name: string; css: string }[] = [
  { id: 'system', name: 'System', css: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  { id: 'inter', name: 'Inter', css: '"Inter Variable", "Inter", -apple-system, system-ui, sans-serif' },
  { id: 'rounded', name: 'SF Rounded', css: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif' },
  { id: 'serif', name: 'Serif', css: 'ui-serif, "New York", Georgia, serif' },
];

export const CODE_FONTS = ['JetBrains Mono', 'SF Mono', 'Menlo', 'Fira Code', 'Monaco', 'Cascadia Code', 'Source Code Pro', 'IBM Plex Mono', 'Courier New'];

export const EDITOR_SYNTAX_THEMES: { id: EditorSyntaxTheme; name: string }[] = [
  { id: 'auto', name: 'Auto (Follow Mode)' },
  { id: 'one-dark', name: 'One Dark' },
  { id: 'github', name: 'GitHub' },
  { id: 'monokai', name: 'Monokai' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'nord', name: 'Nord' },
  { id: 'solarized', name: 'Solarized' },
];

/** Bundled variable fonts are registered under their own family names; custom comma-separated stacks pass through cleanly. */
export const codeFontCss = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed === 'JetBrains Mono') return '"JetBrains Mono Variable", "JetBrains Mono"';
  if (trimmed.includes(',') || trimmed.includes('"') || trimmed.includes("'")) return trimmed;
  return `"${trimmed}"`;
};

export function resolvePalette(theme: ThemeSettings, systemDark: boolean): { palette: ThemePalette; dark: boolean } {
  const preset = THEME_PRESETS.find((p) => p.id === theme.preset) ?? THEME_PRESETS[0];
  const dark = theme.mode === 'dark' || (theme.mode === 'system' && systemDark);
  const palette: ThemePalette = { ...(dark ? preset.dark : preset.light) };
  if (theme.accent) palette.accent = theme.accent;
  for (const [k, v] of Object.entries(theme.overrides)) if (v) palette[k as keyof ThemePalette] = v;
  return { palette, dark };
}
