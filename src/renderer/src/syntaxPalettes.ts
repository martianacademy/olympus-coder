import type { EditorSyntaxTheme } from '@shared/types';

/** Token colours of one syntax theme. Shared by the editor (`editorThemes.ts`) and highlighted chat code. */
export interface SyntaxPalette {
  keyword: string;
  fn: string;
  str: string;
  num: string;
  type: string;
  comment: string;
  prop: string;
  op: string;
  tag: string;
  attr: string;
}

export const SYNTAX_PALETTES = {
  githubDark: { keyword: '#ff7b72', fn: '#d2a8ff', str: '#a5d6ff', num: '#79c0ff', type: '#ffa657', comment: '#8b949e', prop: '#79c0ff', op: '#c9d1d9', tag: '#7ee787', attr: '#79c0ff' },
  githubLight: { keyword: '#cf222e', fn: '#8250df', str: '#0a3069', num: '#0550ae', type: '#953800', comment: '#6e7781', prop: '#0550ae', op: '#24292f', tag: '#116329', attr: '#0550ae' },
  monokai: { keyword: '#f92672', fn: '#a6e22e', str: '#e6db74', num: '#ae81ff', type: '#66d9ef', comment: '#75715e', prop: '#fd971f', op: '#f8f8f2', tag: '#f92672', attr: '#a6e22e' },
  dracula: { keyword: '#ff79c6', fn: '#50fa7b', str: '#f1fa8c', num: '#bd93f9', type: '#8be9fd', comment: '#6272a4', prop: '#ffb86c', op: '#f8f8f2', tag: '#ff79c6', attr: '#50fa7b' },
  nord: { keyword: '#81a1c1', fn: '#88c0d0', str: '#a3be8c', num: '#b48ead', type: '#8fbcbb', comment: '#616e88', prop: '#d8dee9', op: '#81a1c1', tag: '#81a1c1', attr: '#8fbcbb' },
  solarizedDark: { keyword: '#859900', fn: '#268bd2', str: '#2aa198', num: '#d33682', type: '#b58900', comment: '#586e75', prop: '#93a1a1', op: '#839496', tag: '#268bd2', attr: '#b58900' },
  solarizedLight: { keyword: '#859900', fn: '#268bd2', str: '#2aa198', num: '#d33682', type: '#b58900', comment: '#93a1a1', prop: '#586e75', op: '#657b83', tag: '#268bd2', attr: '#b58900' },
  /** `@codemirror/theme-one-dark` colours (the editor's `auto` dark style). */
  oneDark: { keyword: '#c678dd', fn: '#61afef', str: '#98c379', num: '#d19a66', type: '#e5c07b', comment: '#7d8799', prop: '#e06c75', op: '#56b6c2', tag: '#e06c75', attr: '#d19a66' },
} satisfies Record<string, SyntaxPalette>;

/**
 * Palette for code shown in chat. Follows the editor's syntax theme; themes that only have dark colours
 * (Monokai, Dracula, Nord, One Dark) fall back to the GitHub light colours on a light UI so nothing turns unreadable.
 */
export function chatSyntaxPalette(syntax: EditorSyntaxTheme | undefined, dark: boolean): SyntaxPalette {
  const P = SYNTAX_PALETTES;
  switch (syntax ?? 'auto') {
    case 'github':
      return dark ? P.githubDark : P.githubLight;
    case 'solarized':
      return dark ? P.solarizedDark : P.solarizedLight;
    case 'monokai':
      return dark ? P.monokai : P.githubLight;
    case 'dracula':
      return dark ? P.dracula : P.githubLight;
    case 'nord':
      return dark ? P.nord : P.githubLight;
    case 'one-dark':
      return dark ? P.oneDark : P.githubLight;
    case 'auto':
    default:
      return dark ? P.oneDark : P.githubLight;
  }
}

/**
 * Writes `--hl-*` CSS variables for chat code. Each colour is mixed a little toward the body text colour so code
 * sits calmly inside the monochrome chat instead of glaring like a full editor theme.
 */
export function applyChatSyntaxVars(root: HTMLElement, syntax: EditorSyntaxTheme | undefined, dark: boolean): void {
  const p = chatSyntaxPalette(syntax, dark);
  const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, var(--text))`;
  const strength = dark ? 72 : 74;
  root.style.setProperty('--hl-keyword', mix(p.keyword, strength));
  root.style.setProperty('--hl-fn', mix(p.fn, strength));
  root.style.setProperty('--hl-str', mix(p.str, strength));
  root.style.setProperty('--hl-num', mix(p.num, strength));
  root.style.setProperty('--hl-type', mix(p.type, strength));
  root.style.setProperty('--hl-prop', mix(p.prop, strength - 10));
  root.style.setProperty('--hl-tag', mix(p.tag, strength));
  root.style.setProperty('--hl-attr', mix(p.attr, strength));
  root.style.setProperty('--hl-comment', `color-mix(in srgb, ${p.comment} 70%, var(--muted))`);
}
