import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ThemeSettings } from '@shared/types';
import { CODE_FONTS, DEFAULT_THEME, EDITOR_SYNTAX_THEMES } from '@shared/themes';
import { setWrapLines, useWrapLines } from '../../prefs';
import { CodeEditor } from '../Editor';

const EDITOR_SAMPLE = `// Interactive preview — type here to test cursor, brackets, tabs & ligatures
export interface WorkerConfig {
  agent: 'claude' | 'antigravity' | 'codex';
  model?: string;
  retries: number;
}

export function pickFallback(cfg: WorkerConfig, quotaUsed: number): string {
  if (quotaUsed >= 1.0 && cfg.agent !== 'codex') {
    return \`Switch \${cfg.agent} => codex (retries=\${cfg.retries})\`;  
  }
  return cfg.model ?? 'auto';
}
`;

export function EditorSettingsSection({
  t,
  dark,
  set,
}: {
  t: ThemeSettings;
  dark: boolean;
  set: (patch: Partial<ThemeSettings>) => void;
}) {
  const [sampleCode, setSampleCode] = useState(EDITOR_SAMPLE);
  const wrapLines = useWrapLines();
  const customEditorFont = Boolean(t.editorFontFamily && !CODE_FONTS.includes(t.editorFontFamily));
  const [useCustomFont, setUseCustomFont] = useState(customEditorFont);

  const resetEditorOnly = () => {
    setUseCustomFont(false);
    setWrapLines(true);
    set({
      editorFontFamily: DEFAULT_THEME.editorFontFamily,
      editorFontSize: DEFAULT_THEME.editorFontSize,
      editorFontWeight: DEFAULT_THEME.editorFontWeight,
      editorLineHeight: DEFAULT_THEME.editorLineHeight,
      editorLetterSpacing: DEFAULT_THEME.editorLetterSpacing,
      editorLigatures: DEFAULT_THEME.editorLigatures,
      editorSyntaxTheme: DEFAULT_THEME.editorSyntaxTheme,
      editorSurface: DEFAULT_THEME.editorSurface,
      editorLineNumbers: DEFAULT_THEME.editorLineNumbers,
      editorFoldGutter: DEFAULT_THEME.editorFoldGutter,
      editorActiveLine: DEFAULT_THEME.editorActiveLine,
      editorIndentGuides: DEFAULT_THEME.editorIndentGuides,
      editorRulerColumn: DEFAULT_THEME.editorRulerColumn,
      editorRenderWhitespace: DEFAULT_THEME.editorRenderWhitespace,
      editorBracketMatching: DEFAULT_THEME.editorBracketMatching,
      editorSelectionMatch: DEFAULT_THEME.editorSelectionMatch,
      editorScrollPastEnd: DEFAULT_THEME.editorScrollPastEnd,
      editorCursorStyle: DEFAULT_THEME.editorCursorStyle,
      editorCursorWidth: DEFAULT_THEME.editorCursorWidth,
      editorCursorBlink: DEFAULT_THEME.editorCursorBlink,
      editorTabSize: DEFAULT_THEME.editorTabSize,
      editorIndentWithTabs: DEFAULT_THEME.editorIndentWithTabs,
      editorAutoCloseBrackets: DEFAULT_THEME.editorAutoCloseBrackets,
      editorTrimTrailingWhitespace: DEFAULT_THEME.editorTrimTrailingWhitespace,
      editorFinalNewline: DEFAULT_THEME.editorFinalNewline,
    });
  };

  return (
    <>
      <div className="editor-preview-card">
        <div className="editor-preview-head small muted">
          <span>Live Editor Preview · sample.ts</span>
          <span>
            {t.editorFontFamily || t.codeFont} · {t.editorFontSize ? `${t.editorFontSize}px` : `${t.codeFontSize}px`} · tab {t.editorTabSize}
          </span>
        </div>
        <div className="editor-preview-box">
          <CodeEditor path="sample.ts" value={sampleCode} dark={dark} themeOverride={t} onChange={setSampleCode} onSave={() => {}} />
        </div>
      </div>

      <h4 className="settings-sub">Typography &amp; Syntax</h4>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Editor font family</label>
          <select
            className="select"
            value={useCustomFont || customEditorFont ? '__custom__' : (t.editorFontFamily ?? '')}
            onChange={(e) => {
              if (e.target.value === '__custom__') setUseCustomFont(true);
              else {
                setUseCustomFont(false);
                set({ editorFontFamily: e.target.value });
              }
            }}
          >
            <option value="">Follow default code font ({t.codeFont})</option>
            {CODE_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value="__custom__">Custom font family…</option>
          </select>
        </div>
        <div className="field grow">
          <label>Syntax theme</label>
          <select className="select" value={t.editorSyntaxTheme ?? 'auto'} onChange={(e) => set({ editorSyntaxTheme: e.target.value as ThemeSettings['editorSyntaxTheme'] })}>
            {EDITOR_SYNTAX_THEMES.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {(useCustomFont || customEditorFont) && (
        <div className="field">
          <label>Custom monospace font name</label>
          <input
            className="input"
            placeholder='e.g. "Berkeley Mono", "Iosevka", "Victor Mono"'
            value={t.editorFontFamily ?? ''}
            onChange={(e) => set({ editorFontFamily: e.target.value })}
          />
        </div>
      )}
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Editor font size: {t.editorFontSize ? `${t.editorFontSize}px` : `match code (${t.codeFontSize}px)`}</label>
          <input
            type="range"
            min={9.5}
            max={22}
            step={0.5}
            value={t.editorFontSize || 9.5}
            onChange={(e) => {
              const v = Number(e.target.value);
              set({ editorFontSize: v < 10 ? 0 : v });
            }}
          />
        </div>
        <div className="field grow">
          <label>Font weight: {t.editorFontWeight}</label>
          <input type="range" min={300} max={600} step={50} value={t.editorFontWeight} onChange={(e) => set({ editorFontWeight: Number(e.target.value) })} />
        </div>
      </div>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Line height: {(t.editorLineHeight ?? 1.55).toFixed(2)}</label>
          <input type="range" min={1.2} max={2.1} step={0.05} value={t.editorLineHeight} onChange={(e) => set({ editorLineHeight: Number(e.target.value) })} />
        </div>
        <div className="field grow">
          <label>Letter spacing: {(t.editorLetterSpacing ?? 0).toFixed(1)}px</label>
          <input type="range" min={-0.5} max={1.5} step={0.1} value={t.editorLetterSpacing} onChange={(e) => set({ editorLetterSpacing: Number(e.target.value) })} />
        </div>
      </div>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Font ligatures</label>
          <div className="seg">
            <button className={t.editorLigatures !== false ? 'active' : ''} onClick={() => set({ editorLigatures: true })}>
              Enabled
            </button>
            <button className={t.editorLigatures === false ? 'active' : ''} onClick={() => set({ editorLigatures: false })}>
              Disabled
            </button>
          </div>
        </div>
        <div className="field grow">
          <label>Editor background</label>
          <div className="seg">
            {([
              ['surface', 'Surface'],
              ['code', 'Code tint'],
              ['bg', 'Canvas'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.editorSurface ?? 'surface') === id ? 'active' : ''} onClick={() => set({ editorSurface: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <h4 className="settings-sub">Gutter, Guides &amp; Visuals</h4>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Line numbers</label>
          <div className="seg">
            {([
              ['on', 'On'],
              ['relative', 'Relative'],
              ['off', 'Off'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.editorLineNumbers ?? 'on') === id ? 'active' : ''} onClick={() => set({ editorLineNumbers: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field grow">
          <label>Active line highlight</label>
          <div className="seg">
            {([
              ['both', 'Both'],
              ['line', 'Line'],
              ['gutter', 'Gutter'],
              ['off', 'Off'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.editorActiveLine ?? 'both') === id ? 'active' : ''} onClick={() => set({ editorActiveLine: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Render whitespace</label>
          <div className="seg">
            {([
              ['none', 'None'],
              ['trailing', 'Trailing'],
              ['all', 'All'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.editorRenderWhitespace ?? 'none') === id ? 'active' : ''} onClick={() => set({ editorRenderWhitespace: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field grow">
          <label>Column ruler</label>
          <div className="seg">
            {([0, 80, 100, 120] as const).map((col) => (
              <button key={col} className={(t.editorRulerColumn ?? 0) === col ? 'active' : ''} onClick={() => set({ editorRulerColumn: col })}>
                {col === 0 ? 'Off' : String(col)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="editor-checks-grid">
        <label className="check-item">
          <input type="checkbox" checked={t.editorFoldGutter !== false} onChange={(e) => set({ editorFoldGutter: e.target.checked })} />
          Code folding gutter
        </label>
        <label className="check-item">
          <input type="checkbox" checked={t.editorIndentGuides !== false} onChange={(e) => set({ editorIndentGuides: e.target.checked })} />
          Indent guide lines
        </label>
        <label className="check-item">
          <input type="checkbox" checked={t.editorBracketMatching !== false} onChange={(e) => set({ editorBracketMatching: e.target.checked })} />
          Highlight matching brackets
        </label>
        <label className="check-item">
          <input type="checkbox" checked={t.editorSelectionMatch !== false} onChange={(e) => set({ editorSelectionMatch: e.target.checked })} />
          Highlight selection occurrences
        </label>
        <label className="check-item">
          <input type="checkbox" checked={Boolean(t.editorScrollPastEnd)} onChange={(e) => set({ editorScrollPastEnd: e.target.checked })} />
          Scroll past last line
        </label>
        <label className="check-item">
          <input type="checkbox" checked={wrapLines} onChange={(e) => setWrapLines(e.target.checked)} />
          Word wrap long lines
        </label>
      </div>

      <h4 className="settings-sub">Cursor &amp; Caret</h4>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Cursor style</label>
          <div className="seg">
            {([
              ['line', 'Line'],
              ['block', 'Block'],
              ['underline', 'Underline'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.editorCursorStyle ?? 'line') === id ? 'active' : ''} onClick={() => set({ editorCursorStyle: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field grow">
          <label>Cursor blink</label>
          <div className="seg">
            {([
              ['blink', 'Blink'],
              ['smooth', 'Smooth'],
              ['solid', 'Solid'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.editorCursorBlink ?? 'blink') === id ? 'active' : ''} onClick={() => set({ editorCursorBlink: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {(t.editorCursorStyle ?? 'line') !== 'block' && (
        <div className="field">
          <label>Cursor thickness: {t.editorCursorWidth ?? 2}px</label>
          <input type="range" min={1} max={4} step={1} value={t.editorCursorWidth ?? 2} onChange={(e) => set({ editorCursorWidth: Number(e.target.value) })} />
        </div>
      )}

      <h4 className="settings-sub">Indentation &amp; Editing Behavior</h4>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Tab size</label>
          <div className="seg">
            {([2, 4, 8] as const).map((sz) => (
              <button key={sz} className={(t.editorTabSize ?? 2) === sz ? 'active' : ''} onClick={() => set({ editorTabSize: sz })}>
                {sz} spaces
              </button>
            ))}
          </div>
        </div>
        <div className="field grow">
          <label>Indentation character</label>
          <div className="seg">
            <button className={!t.editorIndentWithTabs ? 'active' : ''} onClick={() => set({ editorIndentWithTabs: false })}>
              Spaces
            </button>
            <button className={Boolean(t.editorIndentWithTabs) ? 'active' : ''} onClick={() => set({ editorIndentWithTabs: true })}>
              Tabs
            </button>
          </div>
        </div>
      </div>
      <div className="editor-checks-grid">
        <label className="check-item">
          <input type="checkbox" checked={t.editorAutoCloseBrackets !== false} onChange={(e) => set({ editorAutoCloseBrackets: e.target.checked })} />
          Auto-close brackets &amp; quotes
        </label>
        <label className="check-item">
          <input type="checkbox" checked={Boolean(t.editorTrimTrailingWhitespace)} onChange={(e) => set({ editorTrimTrailingWhitespace: e.target.checked })} />
          Trim trailing whitespace on save
        </label>
        <label className="check-item">
          <input type="checkbox" checked={Boolean(t.editorFinalNewline)} onChange={(e) => set({ editorFinalNewline: e.target.checked })} />
          Insert final newline on save
        </label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn small" onClick={resetEditorOnly}>
          <RotateCcw size={13} /> Reset editor settings
        </button>
      </div>
    </>
  );
}

export function TerminalSettingsSection({ t, set }: { t: ThemeSettings; set: (patch: Partial<ThemeSettings>) => void }) {
  const resetTerminalOnly = () =>
    set({
      terminalFontSize: DEFAULT_THEME.terminalFontSize,
      terminalLineHeight: DEFAULT_THEME.terminalLineHeight,
      terminalCursorStyle: DEFAULT_THEME.terminalCursorStyle,
      terminalCursorBlink: DEFAULT_THEME.terminalCursorBlink,
      terminalScrollback: DEFAULT_THEME.terminalScrollback,
    });

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Customizes the integrated terminals in the right-hand workbench panel. Changes apply live to open terminals.
      </p>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Terminal font size: {t.terminalFontSize ? `${t.terminalFontSize}px` : `match code (${t.codeFontSize}px)`}</label>
          <input
            type="range"
            min={9.5}
            max={20}
            step={0.5}
            value={t.terminalFontSize || 9.5}
            onChange={(e) => {
              const v = Number(e.target.value);
              set({ terminalFontSize: v < 10 ? 0 : v });
            }}
          />
        </div>
        <div className="field grow">
          <label>Line height: {(t.terminalLineHeight ?? 1.25).toFixed(2)}</label>
          <input type="range" min={1.0} max={1.6} step={0.05} value={t.terminalLineHeight ?? 1.25} onChange={(e) => set({ terminalLineHeight: Number(e.target.value) })} />
        </div>
      </div>
      <div className="row" style={{ gap: 14 }}>
        <div className="field grow">
          <label>Cursor shape</label>
          <div className="seg">
            {([
              ['bar', 'Bar'],
              ['block', 'Block'],
              ['underline', 'Underline'],
            ] as const).map(([id, label]) => (
              <button key={id} className={(t.terminalCursorStyle ?? 'bar') === id ? 'active' : ''} onClick={() => set({ terminalCursorStyle: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field grow">
          <label>Cursor blink</label>
          <div className="seg">
            <button className={t.terminalCursorBlink !== false ? 'active' : ''} onClick={() => set({ terminalCursorBlink: true })}>
              Blinking
            </button>
            <button className={t.terminalCursorBlink === false ? 'active' : ''} onClick={() => set({ terminalCursorBlink: false })}>
              Steady
            </button>
          </div>
        </div>
      </div>
      <div className="field">
        <label>Scrollback lines: {(t.terminalScrollback ?? 10000).toLocaleString()}</label>
        <input type="range" min={1000} max={50000} step={1000} value={t.terminalScrollback ?? 10000} onChange={(e) => set({ terminalScrollback: Number(e.target.value) })} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn small" onClick={resetTerminalOnly}>
          <RotateCcw size={13} /> Reset terminal settings
        </button>
      </div>
    </>
  );
}
