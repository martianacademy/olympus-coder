import { useEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  rectangularSelection,
  scrollPastEnd,
} from '@codemirror/view';
import { LanguageDescription, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { WrapText } from 'lucide-react';
import type { ThemeSettings } from '@shared/types';
import { DEFAULT_THEME } from '@shared/themes';
import { buildEditorChromeTheme, buildLineNumbersExtension, resolveSyntaxExtension } from '../editorThemes';
import { setWrapLines, useWrapLines } from '../prefs';
import { getThemeSettings, useThemeSettings } from '../theme';

/** Applies save-time text normalizations (`editorTrimTrailingWhitespace` and `editorFinalNewline`). */
export function formatTextOnSave(raw: string, settings: ThemeSettings = getThemeSettings()): string {
  const s = { ...DEFAULT_THEME, ...settings };
  let out = raw;
  if (s.editorTrimTrailingWhitespace) {
    out = out.replace(/[ \t]+$/gm, '');
  }
  if (s.editorFinalNewline && out.length > 0 && !out.endsWith('\n')) {
    out += '\n';
  }
  return out;
}

function buildConfigurableExtensions(raw: ThemeSettings, dark: boolean, wrapOn: boolean, readOnly: boolean): Extension {
  const s = { ...DEFAULT_THEME, ...raw };
  const tabSize = Math.max(1, Math.min(8, s.editorTabSize ?? 2));
  const unit = s.editorIndentWithTabs ? '\t' : ' '.repeat(tabSize);
  const activeMode = s.editorActiveLine ?? 'both';

  const exts: Extension[] = [
    buildEditorChromeTheme(s),
    resolveSyntaxExtension(s.editorSyntaxTheme, dark),
    buildLineNumbersExtension(s.editorLineNumbers),
    EditorState.tabSize.of(tabSize),
    indentUnit.of(unit),
  ];

  if (s.editorFoldGutter !== false) exts.push(foldGutter());
  if (activeMode === 'both' || activeMode === 'gutter') exts.push(highlightActiveLineGutter());
  if (activeMode === 'both' || activeMode === 'line') exts.push(highlightActiveLine());
  if (s.editorBracketMatching !== false) exts.push(bracketMatching());
  if (s.editorSelectionMatch !== false) exts.push(highlightSelectionMatches());
  if (!readOnly && s.editorAutoCloseBrackets !== false) exts.push(closeBrackets());
  if (s.editorScrollPastEnd) exts.push(scrollPastEnd());
  if (wrapOn) exts.push(EditorView.lineWrapping);

  if (s.editorRenderWhitespace === 'all') exts.push(highlightWhitespace());
  else if (s.editorRenderWhitespace === 'trailing') exts.push(highlightTrailingWhitespace());

  return exts;
}

export function CodeEditor({
  path,
  value,
  dark,
  readOnly,
  line,
  themeOverride,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  dark: boolean;
  readOnly?: boolean;
  /** 1-based line to put the cursor on and scroll to the middle. */
  line?: number;
  /** Optional explicit theme settings (e.g. for live Settings preview before saving). */
  themeOverride?: ThemeSettings;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const configComp = useRef(new Compartment());
  const globalTheme = useThemeSettings();
  const effectiveTheme = themeOverride ?? globalTheme;
  const wrapOn = useWrapLines();
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  // One editor per file path; the parent keys this component by path.
  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        rectangularSelection(),
        crosshairCursor(),
        autocompletion(),
        configComp.current.of(buildConfigurableExtensions(effectiveTheme, dark, wrapOn, Boolean(readOnly))),
        lang.current.of([]),
        EditorState.readOnly.of(Boolean(readOnly)),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: (v) => {
              if (!readOnly) {
                const cur = v.state.doc.toString();
                const formatted = formatTextOnSave(cur, getThemeSettings());
                if (formatted !== cur) {
                  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: formatted } });
                }
              }
              cb.current.onSave();
              return true;
            },
          },
          ...(readOnly ? [] : [indentWithTab]),
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    const desc = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
    if (desc) void desc.load().then((support) => view.current?.dispatch({ effects: lang.current.reconfigure(support) }));
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Reload from disk replaces the whole document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v || !line) return;
    const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
  }, [line, path, value]);

  // Live-reconfigure every typography, gutter, cursor, syntax, whitespace, and indentation option in place.
  useEffect(() => {
    view.current?.dispatch({
      effects: configComp.current.reconfigure(buildConfigurableExtensions(effectiveTheme, dark, wrapOn, Boolean(readOnly))),
    });
  }, [effectiveTheme, dark, wrapOn, readOnly]);

  return <div className="cm-host" ref={host} />;
}

/** A small toggle for wrapping long lines, shown in editor and preview headers. */
export function WrapToggle() {
  const on = useWrapLines();
  return (
    <button
      className={`btn ghost icon wrap-toggle ${on ? 'on' : ''}`}
      title={on ? 'Long lines wrap — click to scroll sideways instead' : 'Long lines scroll sideways — click to wrap them'}
      onClick={() => setWrapLines(!on)}
    >
      <WrapText size={14} />
    </button>
  );
}
