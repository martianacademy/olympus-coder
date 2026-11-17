import { type ReactNode, useState } from 'react';
import { Brain, ChevronDown, Code2, FileText, MessageSquareText, Palette, RotateCcw, SquareTerminal } from 'lucide-react';
import { THEME_TOKENS, type ThemeSettings, type ThemeToken } from '@shared/types';
import { CHAT_WIDTHS, CODE_FONTS, DEFAULT_THEME, resolvePalette, STEPS_SIZES, THEME_PRESETS, UI_FONTS } from '@shared/themes';
import { setExpandSteps, setWrapLines, useExpandSteps } from '../../prefs';
import { EditorSettingsSection, TerminalSettingsSection } from './EditorSettingsPanel';

type AppearanceSection = 'theme' | 'editor' | 'terminal' | 'reading';

const TOKEN_LABELS: Record<ThemeToken, string> = {
  bg: 'Background',
  panel: 'Sidebar',
  surface: 'Cards',
  border: 'Borders',
  text: 'Text',
  muted: 'Muted text',
  accent: 'Accent',
  accentText: 'Text on accent',
  danger: 'Danger',
  success: 'Success',
  warning: 'Warning',
  code: 'Code background',
};

export function ThemeEditor({ theme, onChange, compact }: { theme: ThemeSettings; onChange: (t: ThemeSettings) => void; compact?: boolean }) {
  const [section, setSection] = useState<AppearanceSection>('theme');
  const t: ThemeSettings = { ...DEFAULT_THEME, ...theme };
  const set = (patch: Partial<ThemeSettings>) => onChange({ ...theme, ...patch });

  const expandSteps = useExpandSteps();
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const { palette, dark } = resolvePalette(t, systemDark);
  // Colors are stored per mode: the pickers below write the bucket of the theme the user is looking at,
  // so a color set in dark never shows up in light (and the other way round).
  const colorBucketKey = dark ? 'overridesDark' : 'overridesLight';
  const colorBucket = dark ? t.overridesDark : t.overridesLight;
  const accentKey = dark ? 'accentDark' : 'accentLight';
  const accentValue = dark ? t.accentDark : t.accentLight;
  const setAccent = (value: string) => set({ [accentKey]: value } as Partial<ThemeSettings>);
  const clearCustomColors = { accent: undefined, overrides: {}, accentDark: undefined, accentLight: undefined, overridesDark: {}, overridesLight: {} };

  if (compact) {
    return (
      <>
        <div className="field">
          <label>Mode</label>
          <div className="seg">
            {(['system', 'light', 'dark'] as const).map((m) => (
              <button key={m} className={theme.mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
                {m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Theme</label>
          <div className="preset-grid">
            {THEME_PRESETS.map((p) => {
              const pal = resolvePalette({ ...theme, preset: p.id, ...clearCustomColors }, systemDark).palette;
              return (
                <div key={p.id} className={`preset ${theme.preset === p.id ? 'active' : ''}`} onClick={() => set({ preset: p.id, ...clearCustomColors })}>
                  <div className="preset-swatch">
                    <span style={{ background: pal.panel }} />
                    <span style={{ background: pal.bg }} />
                    <span style={{ background: pal.surface }} />
                    <span style={{ background: pal.accent }} />
                  </div>
                  <div className="small" style={{ fontWeight: 550 }}>
                    {p.name}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="field">
          <label>Accent color</label>
          <div className="row">
            <input type="color" value={palette.accent} onChange={(e) => setAccent(e.target.value)} />
            <span className="small muted">{palette.accent}</span>
            {accentValue && (
              <button className="btn small ghost" onClick={() => set({ [accentKey]: undefined } as Partial<ThemeSettings>)}>
                Reset
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h3>Appearance</h3>
      <div className="seg appearance-tabs" role="tablist" aria-label="Appearance sections">
        <button className={section === 'theme' ? 'active' : ''} onClick={() => setSection('theme')}>
          <Palette size={13} /> Theme &amp; Colors
        </button>
        <button className={section === 'editor' ? 'active' : ''} onClick={() => setSection('editor')}>
          <Code2 size={13} /> Code Editor
        </button>
        <button className={section === 'terminal' ? 'active' : ''} onClick={() => setSection('terminal')}>
          <SquareTerminal size={13} /> Terminal
        </button>
        <button className={section === 'reading' ? 'active' : ''} onClick={() => setSection('reading')}>
          <MessageSquareText size={13} /> Chat &amp; Reading
        </button>
      </div>

      {section === 'theme' && (
        <>
          <div className="field">
            <label>Mode</label>
            <div className="seg">
              {(['system', 'light', 'dark'] as const).map((m) => (
                <button key={m} className={theme.mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
                  {m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Theme preset</label>
            <div className="preset-grid">
              {THEME_PRESETS.map((p) => {
                const pal = resolvePalette({ ...theme, preset: p.id, ...clearCustomColors }, systemDark).palette;
                return (
                  <div key={p.id} className={`preset ${theme.preset === p.id ? 'active' : ''}`} onClick={() => set({ preset: p.id, ...clearCustomColors })}>
                    <div className="preset-swatch">
                      <span style={{ background: pal.panel }} />
                      <span style={{ background: pal.bg }} />
                      <span style={{ background: pal.surface }} />
                      <span style={{ background: pal.accent }} />
                    </div>
                    <div className="small" style={{ fontWeight: 550 }}>
                      {p.name}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="field">
            <label>Accent color</label>
            <div className="row">
              <input type="color" value={palette.accent} onChange={(e) => setAccent(e.target.value)} />
              <span className="small muted">{palette.accent}</span>
              {accentValue && (
                <button className="btn small ghost" onClick={() => set({ [accentKey]: undefined } as Partial<ThemeSettings>)}>
                  Reset
                </button>
              )}
            </div>
          </div>
          <div className="field">
            <label>Customize palette tokens</label>
            <div className="color-row">
              {THEME_TOKENS.filter((tok) => tok !== 'accent').map((tok) => (
                <label key={tok}>
                  <input
                    type="color"
                    value={palette[tok]}
                    onChange={(e) => set({ [colorBucketKey]: { ...colorBucket, [tok]: e.target.value } } as Partial<ThemeSettings>)}
                  />
                  {TOKEN_LABELS[tok]}
                </label>
              ))}
            </div>
            <span className="small muted">A color you set applies to the theme you are looking at — dark and light keep separate colors.</span>
            {Object.keys(colorBucket ?? {}).length > 0 && (
              <div>
                <button
                  className="btn small"
                  title="Restore this theme's custom colors to the preset defaults"
                  onClick={() => set({ [colorBucketKey]: {} } as Partial<ThemeSettings>)}
                >
                  <RotateCcw size={13} /> Reset custom colors
                </button>
              </div>
            )}
          </div>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>UI font</label>
              <select className="select" value={theme.uiFont} onChange={(e) => set({ uiFont: e.target.value })}>
                {UI_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field grow">
              <label>Default code font</label>
              <select className="select" value={theme.codeFont} onChange={(e) => set({ codeFont: e.target.value })}>
                {CODE_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>App font size: {theme.fontSize}px</label>
              <input type="range" min={12} max={18} value={theme.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>Default code size: {t.codeFontSize}px</label>
              <input type="range" min={10} max={18} step={0.5} value={t.codeFontSize} onChange={(e) => set({ codeFontSize: Number(e.target.value) })} />
            </div>
          </div>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Corner radius: {theme.radius}px</label>
              <input type="range" min={0} max={18} value={theme.radius} onChange={(e) => set({ radius: Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>Density</label>
              <div className="seg">
                {(['comfortable', 'compact'] as const).map((d) => (
                  <button key={d} data-density-option={d} className={t.density === d ? 'active' : ''} onClick={() => set({ density: d })}>
                    {d === 'comfortable' ? 'Comfortable' : 'Compact'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <h4 className="settings-sub">Sidebar</h4>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Project spacing: {t.sidebarProjectGap}px</label>
              <input type="range" min={0} max={24} step={1} value={t.sidebarProjectGap} data-testid="sb-project-gap" onChange={(e) => set({ sidebarProjectGap: Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>Session spacing: {t.sidebarRowGap}px</label>
              <input type="range" min={0} max={12} step={1} value={t.sidebarRowGap} data-testid="sb-row-gap" onChange={(e) => set({ sidebarRowGap: Number(e.target.value) })} />
            </div>
          </div>
          <div className="field">
            <label>Sidebar text size: {t.sidebarFontSize ? `${t.sidebarFontSize}px` : `${theme.fontSize}px (same as app)`}</label>
            {/* 0 = follow the app font size; picking the app size again goes back to following it. */}
            <input
              type="range"
              min={11}
              max={18}
              step={1}
              value={t.sidebarFontSize || theme.fontSize}
              data-testid="sb-font-size"
              onChange={(e) => set({ sidebarFontSize: Number(e.target.value) === theme.fontSize ? 0 : Number(e.target.value) })}
            />
          </div>
        </>
      )}

      {section === 'editor' && <EditorSettingsSection t={t} dark={dark} set={set} />}
      {section === 'terminal' && <TerminalSettingsSection t={t} set={set} />}

      {section === 'reading' && (
        <>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Text weight: {t.textWeight}</label>
              <input type="range" min={300} max={500} step={50} value={t.textWeight} onChange={(e) => set({ textWeight: Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>Bold weight: {t.boldWeight}</label>
              <input type="range" min={500} max={800} step={50} value={t.boldWeight} onChange={(e) => set({ boldWeight: Number(e.target.value) })} />
            </div>
          </div>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Chat text size: {t.chatFontSize ? `${t.chatFontSize}px` : 'same as app'}</label>
              <input type="range" min={0} max={20} step={1} value={t.chatFontSize || 0} onChange={(e) => set({ chatFontSize: Number(e.target.value) < 12 ? 0 : Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>Line spacing: {t.lineHeight?.toFixed(2)}</label>
              <input type="range" min={1.3} max={2} step={0.05} value={t.lineHeight} onChange={(e) => set({ lineHeight: Number(e.target.value) })} />
            </div>
          </div>
          <div className="field">
            <label>Chat width</label>
            <div className="seg" data-testid="chat-width">
              {CHAT_WIDTHS.map((w) => (
                <button key={w.id} className={t.chatWidth === w.id ? 'active' : ''} onClick={() => set({ chatWidth: w.id })}>
                  {w.name}
                </button>
              ))}
            </div>
          </div>
          <h4 className="settings-sub">Thinking &amp; tool steps</h4>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Thinking style</label>
              <div className="seg">
                <button className={t.thinkingItalic ? 'active' : ''} onClick={() => set({ thinkingItalic: true })}>
                  <i>Italic</i>
                </button>
                <button className={!t.thinkingItalic ? 'active' : ''} onClick={() => set({ thinkingItalic: false })}>
                  Upright
                </button>
              </div>
            </div>
            <div className="field grow">
              <label>Steps in chats</label>
              <div className="seg">
                <button className={!expandSteps ? 'active' : ''} onClick={() => setExpandSteps(false)}>
                  Folded
                </button>
                <button className={expandSteps ? 'active' : ''} onClick={() => setExpandSteps(true)}>
                  Open
                </button>
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Thinking brightness: {t.thinkingOpacity}%</label>
              <input type="range" min={40} max={100} step={5} value={t.thinkingOpacity} onChange={(e) => set({ thinkingOpacity: Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>Thinking size: {t.thinkingSize}%</label>
              <input type="range" min={80} max={100} step={5} value={t.thinkingSize} onChange={(e) => set({ thinkingSize: Number(e.target.value) })} />
            </div>
          </div>
          <div className="field">
            <label>Steps &amp; tool output size</label>
            <div className="seg" data-testid="steps-size">
              {STEPS_SIZES.map((s) => (
                <button key={s.id} className={t.stepsSize === s.id ? 'active' : ''} onClick={() => set({ stepsSize: s.id })}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="appearance-preview">
            <div className="small muted" style={{ marginBottom: 6 }}>
              Preview
            </div>
            <div className="msg-agent">
              <p>
                A reply reads like this, with <b>bold words</b> and <code>inline code</code>.
              </p>
            </div>
            <div className="thought msg-agent">Thinking looks like this — quieter, so the answer stands out.</div>
            <StepsPreview />
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
        <button
          className="btn"
          onClick={() => {
            setExpandSteps(false);
            setWrapLines(true);
            onChange({ ...DEFAULT_THEME });
          }}
          title="Restore theme, colors, code editor, terminal, and chat appearance to factory defaults"
        >
          <RotateCcw size={13} /> Reset all appearance to defaults
        </button>
      </div>
    </>
  );
}

/** A static, non-interactive copy of a settled WorkGroup (same classes), so Steps size changes show live. */
function StepsPreview() {
  const rows: { icon: ReactNode; verb: string; target: string; mono?: boolean }[] = [
    { icon: <Brain size={14} />, verb: 'Thought', target: 'Read the entry file first' },
    { icon: <FileText size={14} />, verb: 'Read', target: 'src/app.ts' },
    { icon: <SquareTerminal size={14} />, verb: 'Ran', target: 'npm test', mono: true },
  ];
  return (
    <div className="tool-group work-group appearance-steps-preview" aria-hidden="true" data-testid="steps-preview">
      <div className="tool-group-head work-group-head">
        <span className="grow wg-settled-title">
          <span className="wg-headline">Worked for 28s</span>
          <span className="wg-detail wg-part"> · 1 command, 1 file read</span>
        </span>
        <ChevronDown size={14} className="wg-chev" />
      </div>
      <div className="tool-group-body work-group-body">
        {rows.map((r) => (
          <div key={r.verb} className="wg-step wg-step-done">
            <span className="wg-step-icon">{r.icon}</span>
            <div className="tool-row">
              <div className="tool-row-head">
                <span className="tool-badge wg-verb">{r.verb}</span>
                <span className={`grow ellipsis tool-row-title ${r.mono ? 'mono cmd-term-title' : 'human'}`}>{r.target}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
