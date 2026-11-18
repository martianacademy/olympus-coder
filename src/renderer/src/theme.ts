import { useSyncExternalStore } from 'react';
import type { ThemeSettings } from '@shared/types';
import { CHAT_WIDTHS, codeFontCss, DEFAULT_THEME, resolvePalette, STEPS_SIZES, UI_FONTS, withPhoneTheme } from '@shared/themes';
import { applyChatSyntaxVars } from './syntaxPalettes';
import { isRemoteBrowser } from './responsive';

const media = window.matchMedia('(prefers-color-scheme: dark)');

let currentTheme: ThemeSettings = { ...DEFAULT_THEME };
const themeListeners = new Set<() => void>();

/** Returns the active merged `ThemeSettings` snapshot for non-React consumers (e.g. xterm observers). */
export function getThemeSettings(): ThemeSettings {
  return currentTheme;
}

/** Subscribes a React component (such as `CodeEditor`) to live `ThemeSettings` updates. */
export function useThemeSettings(): ThemeSettings {
  return useSyncExternalStore(
    (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    () => currentTheme,
  );
}

export function applyTheme(theme: ThemeSettings) {
  // A phone (or any browser connected to this Mac) uses its own Appearance → Phone values on top of the Mac's.
  const t: ThemeSettings = isRemoteBrowser() ? withPhoneTheme(theme) : { ...DEFAULT_THEME, ...theme };
  currentTheme = t;
  const { palette, dark } = resolvePalette(t, media.matches);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(palette)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty('--font-size', `${t.fontSize}px`);
  // Fixed px sizes in the chat and sidebar are written as `calc(Npx * var(--ui-scale))` so the App font size reaches them.
  root.style.setProperty('--ui-scale', String(Math.round((t.fontSize / 14) * 1000) / 1000));
  root.style.setProperty('--radius', `${t.radius}px`);
  root.style.setProperty('--ui-font', UI_FONTS.find((f) => f.id === t.uiFont)?.css ?? UI_FONTS[0].css);
  const codeFamily = `${codeFontCss(t.codeFont)}, ui-monospace, Menlo, monospace`;
  root.style.setProperty('--code-font', codeFamily);
  root.dataset.density = t.density === 'compact' ? 'compact' : 'comfortable';
  root.dataset.userMsg = t.userMessageStyle === 'plain' ? 'plain' : 'bubble';
  root.dataset.msgTimes = t.showMessageTimes ? 'on' : 'off';
  root.dataset.motion = t.reduceMotion === 'on' ? 'reduce' : 'system';
  root.style.setProperty('--text-weight', String(t.textWeight));
  root.style.setProperty('--bold-weight', String(t.boldWeight));
  const chatSize = t.chatFontSize || t.fontSize;
  root.style.setProperty('--chat-size', `${chatSize}px`);
  // Steps follow the chat text (13px next to 14px by default) times the chosen Steps size.
  // Code inside step boxes follows the code size times the same Steps size factor.
  const stepsFactor = STEPS_SIZES.find((s) => s.id === t.stepsSize)?.scale ?? 1;
  root.style.setProperty('--steps-scale', String(Math.round((chatSize / 14) * stepsFactor * 1000) / 1000));
  root.style.setProperty('--steps-factor', String(stepsFactor));
  const cw = CHAT_WIDTHS.find((w) => w.id === t.chatWidth)?.px;
  root.style.setProperty('--chat-width', cw === 0 ? '100%' : `${cw ?? 780}px`);
  // Sidebar spacing and text (defaults reproduce the original look: 2px under each project, rows touching, app font size).
  root.style.setProperty('--sb-project-gap', `${t.sidebarProjectGap ?? 2}px`);
  root.style.setProperty('--sb-row-gap', `${t.sidebarRowGap ?? 0}px`);
  root.style.setProperty('--sb-font-size', t.sidebarFontSize ? `${t.sidebarFontSize}px` : 'var(--font-size)');
  root.style.setProperty('--line-height', String(t.lineHeight));
  root.style.setProperty('--code-size', `${t.codeFontSize}px`);
  root.style.setProperty('--thinking-style', t.thinkingItalic ? 'italic' : 'normal');
  root.style.setProperty('--thinking-opacity', `${t.thinkingOpacity}%`);
  root.style.setProperty('--thinking-size', `${(t.thinkingSize ?? 95) / 100}em`);

  // Editor & terminal CSS variables for instant DOM & observer updates
  const editorFamily = t.editorFontFamily?.trim() ? `${codeFontCss(t.editorFontFamily)}, ui-monospace, Menlo, monospace` : codeFamily;
  const editorSize = t.editorFontSize && t.editorFontSize > 0 ? t.editorFontSize : (t.codeFontSize ?? 12.5);
  const termSize = t.terminalFontSize && t.terminalFontSize > 0 ? t.terminalFontSize : (t.codeFontSize ?? 12.5);
  root.style.setProperty('--editor-font', editorFamily);
  root.style.setProperty('--editor-size', `${editorSize}px`);
  root.style.setProperty('--editor-line-height', String(t.editorLineHeight ?? 1.55));
  root.style.setProperty('--editor-letter-spacing', `${t.editorLetterSpacing ?? 0}px`);
  root.style.setProperty('--term-size', `${termSize}px`);
  root.style.setProperty('--term-line-height', String(t.terminalLineHeight ?? 1.25));

  applyChatSyntaxVars(root, t.editorSyntaxTheme, dark);

  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  themeListeners.forEach((fn) => fn());
}

export function onSystemThemeChange(fn: () => void) {
  media.addEventListener('change', fn);
  return () => media.removeEventListener('change', fn);
}
