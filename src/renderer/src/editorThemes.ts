import type { Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { tags as t } from '@lezer/highlight';
import type { EditorLineNumbers, EditorSyntaxTheme, ThemeSettings } from '@shared/types';
import { codeFontCss, DEFAULT_THEME } from '@shared/themes';
import { SYNTAX_PALETTES, type SyntaxPalette } from './syntaxPalettes';

function makeHighlight(p: SyntaxPalette) {
  return HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.modifier], color: p.keyword, fontWeight: '500' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: p.fn },
    { tag: [t.string, t.special(t.string), t.regexp], color: p.str },
    { tag: [t.number, t.bool, t.null, t.atom], color: p.num },
    { tag: [t.typeName, t.className, t.namespace, t.macroName], color: p.type },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: p.prop },
    { tag: [t.operator, t.punctuation], color: p.op },
    { tag: [t.tagName], color: p.tag },
    { tag: [t.attributeName], color: p.attr },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.heading, color: p.keyword, fontWeight: '700' },
  ]);
}

const githubDark = makeHighlight(SYNTAX_PALETTES.githubDark);
const githubLight = makeHighlight(SYNTAX_PALETTES.githubLight);
const monokaiStyle = makeHighlight(SYNTAX_PALETTES.monokai);
const draculaStyle = makeHighlight(SYNTAX_PALETTES.dracula);
const nordStyle = makeHighlight(SYNTAX_PALETTES.nord);
const solarizedDark = makeHighlight(SYNTAX_PALETTES.solarizedDark);
const solarizedLight = makeHighlight(SYNTAX_PALETTES.solarizedLight);

/** Resolves the selected syntax highlighting theme into a CodeMirror 6 extension. */
export function resolveSyntaxExtension(syntax: EditorSyntaxTheme | undefined, dark: boolean): Extension {
  switch (syntax ?? 'auto') {
    case 'one-dark':
      return syntaxHighlighting(oneDarkHighlightStyle);
    case 'github':
      return syntaxHighlighting(dark ? githubDark : githubLight);
    case 'monokai':
      return syntaxHighlighting(monokaiStyle);
    case 'dracula':
      return syntaxHighlighting(draculaStyle);
    case 'nord':
      return syntaxHighlighting(nordStyle);
    case 'solarized':
      return syntaxHighlighting(dark ? solarizedDark : solarizedLight);
    case 'auto':
    default:
      return syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle);
  }
}

/** Builds line-number gutter extension (`on`, Vim-style `relative` around cursor line, or `off`). */
export function buildLineNumbersExtension(mode: EditorLineNumbers | undefined): Extension {
  if (mode === 'off') return [];
  if (mode === 'relative') {
    return [
      lineNumbers({
        formatNumber: (lineNo, state) => {
          const headLine = state.doc.lineAt(state.selection.main.head).number;
          if (lineNo === headLine) return String(lineNo);
          return String(Math.abs(lineNo - headLine));
        },
      }),
      // Force gutter refresh when cursor moves to another line so relative offsets stay live.
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) {
          const prev = u.startState.doc.lineAt(u.startState.selection.main.head).number;
          const next = u.state.doc.lineAt(u.state.selection.main.head).number;
          if (prev !== next) u.view.requestMeasure();
        }
      }),
    ];
  }
  return lineNumbers();
}

/** Builds the live CodeMirror 6 chrome, typography, cursor, indent-guide, and ruler theme from `ThemeSettings`. */
export function buildEditorChromeTheme(raw: ThemeSettings): Extension {
  const s = { ...DEFAULT_THEME, ...raw };
  const fontStack = s.editorFontFamily?.trim()
    ? `${codeFontCss(s.editorFontFamily)}, ui-monospace, Menlo, monospace`
    : `${codeFontCss(s.codeFont)}, ui-monospace, Menlo, monospace`;
  const fontSize = s.editorFontSize && s.editorFontSize > 0 ? s.editorFontSize : (s.codeFontSize ?? 12.5);
  const lineHeight = s.editorLineHeight ?? 1.55;
  const letterSpacing = s.editorLetterSpacing ?? 0;
  const fontWeight = s.editorFontWeight ?? 400;
  const ligatures = s.editorLigatures !== false ? 'contextual common-ligatures' : 'none';
  const bgVar = s.editorSurface === 'code' ? 'var(--code)' : s.editorSurface === 'bg' ? 'var(--bg)' : 'var(--surface)';

  const activeMode = s.editorActiveLine ?? 'both';
  const showLineBg = activeMode === 'both' || activeMode === 'line';
  const showGutterBg = activeMode === 'both' || activeMode === 'gutter';

  const cursorStyle = s.editorCursorStyle ?? 'line';
  const cursorWidth = Math.min(4, Math.max(1, s.editorCursorWidth ?? 2));
  const cursorBlink = s.editorCursorBlink ?? 'blink';

  const cursorCss: Record<string, string> =
    cursorStyle === 'block'
      ? {
          borderLeft: 'none',
          width: '0.62em',
          marginLeft: '0',
          backgroundColor: 'color-mix(in srgb, var(--accent) 52%, transparent)',
          outline: '1px solid var(--accent)',
        }
      : cursorStyle === 'underline'
        ? {
            borderLeft: 'none',
            width: '0.62em',
            marginLeft: '0',
            borderBottom: `${Math.max(2, cursorWidth)}px solid var(--accent)`,
          }
        : {
            borderLeftWidth: `${cursorWidth}px`,
            borderLeftStyle: 'solid',
            borderLeftColor: 'var(--accent)',
          };

  if (cursorBlink === 'solid') {
    cursorCss.animation = 'none !important';
    cursorCss.opacity = '1 !important';
  } else if (cursorBlink === 'smooth') {
    cursorCss.animation = 'olympus-cm-pulse 1.15s ease-in-out infinite !important';
  }

  const tabCols = Math.max(1, s.editorTabSize ?? 2);
  const bgLayers: string[] = [];
  const bgSizes: string[] = [];
  const bgPositions: string[] = [];
  const bgRepeats: string[] = [];

  if (s.editorRulerColumn && s.editorRulerColumn > 0) {
    bgLayers.push('linear-gradient(to right, color-mix(in srgb, var(--border) 85%, transparent) 1px, transparent 1px)');
    bgSizes.push('100% 100%');
    bgPositions.push(`calc(4px + ${s.editorRulerColumn}ch) 0`);
    bgRepeats.push('no-repeat');
  }
  if (s.editorIndentGuides !== false) {
    bgLayers.push('linear-gradient(to right, color-mix(in srgb, var(--border) 62%, transparent) 1px, transparent 1px)');
    bgSizes.push(`${tabCols}ch 100%`);
    bgPositions.push('4px 0');
    bgRepeats.push('repeat-x');
  }

  return EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: bgVar,
      color: 'var(--text)',
      fontSize: `${fontSize}px`,
    },
    '.cm-scroller': {
      fontFamily: fontStack,
      lineHeight: String(lineHeight),
      letterSpacing: `${letterSpacing}px`,
      fontWeight: String(fontWeight),
      fontVariantLigatures: ligatures,
    },
    '.cm-content': {
      fontFamily: fontStack,
      fontVariantLigatures: ligatures,
      caretColor: cursorStyle === 'line' ? 'var(--accent)' : 'transparent',
    },
    '.cm-line': bgLayers.length
      ? {
          backgroundImage: bgLayers.join(', '),
          backgroundSize: bgSizes.join(', '),
          backgroundPosition: bgPositions.join(', '),
          backgroundRepeat: bgRepeats.join(', '),
        }
      : {},
    '.cm-gutters': {
      backgroundColor: bgVar,
      color: 'var(--muted)',
      borderRight: '1px solid var(--border)',
      fontFamily: fontStack,
    },
    '.cm-activeLine': {
      backgroundColor: showLineBg ? 'color-mix(in srgb, var(--text) 4.5%, transparent)' : 'transparent',
    },
    '.cm-activeLineGutter': {
      backgroundColor: showGutterBg ? 'color-mix(in srgb, var(--text) 7%, transparent)' : 'transparent',
      color: showGutterBg ? 'var(--text)' : 'var(--muted)',
    },
    '.cm-cursorLayer': cursorBlink === 'solid' ? { animation: 'none !important' } : {},
    '&.cm-focused .cm-cursor, .cm-cursor': cursorCss,
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)',
    },
    '.cm-whitespace, .cm-highlightSpace, .cm-highlightTab': {
      opacity: '0.45',
    },
    '.cm-trailingSpace': {
      backgroundColor: 'color-mix(in srgb, var(--danger) 22%, transparent)',
    },
    '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 35%, transparent)' },
    '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)' },
  });
}
