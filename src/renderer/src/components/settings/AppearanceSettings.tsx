import { useState } from 'react';
import { ChevronDown, Code2, MessageSquareText, Palette, RotateCcw, Smartphone, SquareTerminal } from 'lucide-react';
import { THEME_TOKENS, type EditorSyntaxTheme, type ThemeSettings, type ThemeToken } from '@shared/types';
import { CHAT_WIDTHS, CODE_FONTS, DEFAULT_THEME, EDITOR_SYNTAX_THEMES, resolvePalette, STEPS_SIZES, THEME_PRESETS, UI_FONTS, withPhoneTheme } from '@shared/themes';
import { setExpandSteps, setWrapLines, useExpandSteps } from '../../prefs';
import { isRemoteBrowser } from '../../responsive';
import { ReadingPreview } from './AppearancePreview';
import { EditorSettingsSection, TerminalSettingsSection } from './EditorSettingsPanel';
import { PhoneAppearance } from './PhoneAppearance';

type AppearanceSection = 'phone' | 'theme' | 'editor' | 'terminal' | 'reading';

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
  // The Phone tab exists only on a phone (or a browser connected to this Mac), and opens first there.
  const remote = isRemoteBrowser();
  const [section, setSection] = useState<AppearanceSection>(remote ? 'phone' : 'theme');
  const t: ThemeSettings = { ...DEFAULT_THEME, ...theme };
  const set = (patch: Partial<ThemeSettings>) => onChange({ ...theme, ...patch });

  const expandSteps = useExpandSteps();
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // On a phone the color pickers edit the colors of the mode the phone is showing (its own mode may differ from the Mac's).
  const { palette, dark } = resolvePalette(remote ? { ...t, mode: withPhoneTheme(t).mode } : t, systemDark);
  // Colors are stored per mode: the pickers below write the bucket of the theme the user is looking at,
  // so a color set in dark never shows up in light (and the other way round).
  const colorBucketKey = dark ? 'overridesDark' : 'overridesLight';
  const colorBucket = dark ? t.overridesDark : t.overridesLight;
  const accentKey = dark ? 'accentDark' : 'accentLight';
  const accentValue = dark ? t.accentDark : t.accentLight;
  const setAccent = (value: string) => set({ [accentKey]: value } as Partial<ThemeSettings>);
  const clearCustomColors = { accent: undefined, overrides: {}, accentDark: undefined, accentLight: undefined, overridesDark: {}, overridesLight: {} };
  const hasCustomColors = Object.keys(colorBucket ?? {}).length > 0;
  const [showCustomColors, setShowCustomColors] = useState(hasCustomColors);

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
        {remote && (
          <button className={section === 'phone' ? 'active' : ''} data-testid="appearance-phone-tab" onClick={() => setSection('phone')}>
            <Smartphone size={13} /> Phone
          </button>
        )}
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

      {remote && section !== 'phone' && (
        <p className="small muted" data-testid="appearance-mac-hint" style={{ margin: '0 0 10px' }}>
          Changes here apply to the Mac too. Sizes and mode just for this phone are under Phone.
        </p>
      )}

      {section === 'phone' && <PhoneAppearance theme={theme} onChange={onChange} preview={<ReadingPreview />} />}

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
          <div className="row" style={{ gap: 14, alignItems: 'flex-end' }}>
            <div className="field grow">
              <label>Accent color</label>
              <div className="row">
                <input type="color" value={palette.accent} onChange={(e) => setAccent(e.target.value)} />
                <span className="small muted">{palette.accent}</span>
                {accentValue && (
                  <button className="btn small ghost" onClick={() => set({ [accentKey]: undefined } as Partial<ThemeSettings>)}>
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  className="btn small ghost"
                  data-testid="toggle-custom-colors"
                  onClick={() => setShowCustomColors((v) => !v)}
                  style={{ marginLeft: 'auto', gap: 4 }}
                >
                  Custom colors{hasCustomColors ? ` (${Object.keys(colorBucket ?? {}).length})` : ''}
                  <ChevronDown size={13} style={{ transform: showCustomColors ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                </button>
              </div>
            </div>
            <div className="field grow">
              <label>Syntax colors</label>
              <select
                className="select"
                data-testid="theme-syntax-colors"
                value={t.editorSyntaxTheme ?? 'auto'}
                onChange={(e) => set({ editorSyntaxTheme: e.target.value as EditorSyntaxTheme })}
              >
                {EDITOR_SYNTAX_THEMES.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {showCustomColors && (
            <div className="field" data-testid="custom-colors-panel">
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
              {hasCustomColors && (
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
          )}
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
          <div className="field">
            <label>Reduce motion</label>
            <div className="seg" data-testid="reduce-motion">
              <button className={(t.reduceMotion ?? 'system') === 'system' ? 'active' : ''} onClick={() => set({ reduceMotion: 'system' })}>
                Follow system
              </button>
              <button className={t.reduceMotion === 'on' ? 'active' : ''} onClick={() => set({ reduceMotion: 'on' })}>
                On
              </button>
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
          <div className="row" style={{ gap: 14 }}>
            <div className="field grow">
              <label>Your messages</label>
              <div className="seg" data-testid="user-msg-style">
                <button className={(t.userMessageStyle ?? 'bubble') === 'bubble' ? 'active' : ''} onClick={() => set({ userMessageStyle: 'bubble' })}>
                  Bubble
                </button>
                <button className={t.userMessageStyle === 'plain' ? 'active' : ''} onClick={() => set({ userMessageStyle: 'plain' })}>
                  Plain
                </button>
              </div>
            </div>
            <div className="field grow">
              <label>Message times</label>
              <div className="seg" data-testid="show-msg-times">
                <button className={!t.showMessageTimes ? 'active' : ''} onClick={() => set({ showMessageTimes: false })}>
                  Hidden
                </button>
                <button className={Boolean(t.showMessageTimes) ? 'active' : ''} onClick={() => set({ showMessageTimes: true })}>
                  Show on hover
                </button>
              </div>
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
          <div className="field">
            <label>Running step right fade: {(t.liveStepFade ?? 40) > 0 ? `${t.liveStepFade ?? 40}px` : 'Off'}</label>
            <input
              type="range"
              min={0}
              max={120}
              step={4}
              value={t.liveStepFade ?? 40}
              data-testid="live-step-fade"
              onChange={(e) => set({ liveStepFade: Number(e.target.value) })}
            />
          </div>
          <ReadingPreview />
        </>
      )}

      {/* Hidden on the Phone tab: it resets the Mac. The phone's own look has its own reset there. */}
      {section !== 'phone' && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
          <button
            className="btn"
            onClick={() => {
              setExpandSteps(false);
              setWrapLines(true);
              onChange({ ...DEFAULT_THEME, phone: theme.phone });
            }}
            title="Restore theme, colors, code editor, terminal, and chat appearance to factory defaults"
          >
            <RotateCcw size={13} /> Reset all appearance to defaults
          </button>
        </div>
      )}
    </>
  );
}
