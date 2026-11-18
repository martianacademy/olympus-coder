import { type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import type { PhoneTheme, ThemeSettings } from '@shared/types';
import { DEFAULT_THEME, PHONE_TEXT_MAX, PHONE_TEXT_MIN, STEPS_SIZES, withPhoneTheme } from '@shared/themes';

/**
 * Settings → Appearance → Phone: mode and sizes used only on phones and browsers connected to this Mac.
 * Stored in `theme.phone`; a key that is not set follows the Mac. Text size scales chat, code and steps with it.
 */
export function PhoneAppearance({
  theme,
  onChange,
  preview,
}: {
  theme: ThemeSettings;
  onChange: (t: ThemeSettings) => void;
  preview?: ReactNode;
}) {
  const t: ThemeSettings = { ...DEFAULT_THEME, ...theme };
  const p: PhoneTheme = t.phone ?? {};
  const eff = withPhoneTheme(t);
  const setPhone = <K extends keyof PhoneTheme>(key: K, value: PhoneTheme[K] | undefined) => {
    const next: PhoneTheme = { ...p };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...theme, phone: next });
  };
  const chatPx = eff.chatFontSize || eff.fontSize;
  const isSet = Object.values(p).some((v) => v !== undefined);
  const head = (label: string, reset: { label: string; onClick: () => void } | null) => (
    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
      <label>{label}</label>
      {reset && (
        <button className="btn small ghost" onClick={reset.onClick}>
          {reset.label}
        </button>
      )}
    </div>
  );

  return (
    <div data-testid="appearance-phone">
      <p className="small muted" style={{ margin: '0 0 12px' }}>
        Only for this phone and other browsers connected to this Mac. The Mac keeps its own look, and anything you leave alone here follows the
        Mac.
      </p>
      <div className="field">
        <label>Mode</label>
        <div className="seg" data-testid="phone-mode">
          {(['same', 'system', 'light', 'dark'] as const).map((m) => (
            <button key={m} className={(p.mode ?? 'same') === m ? 'active' : ''} onClick={() => setPhone('mode', m === 'same' ? undefined : m)}>
              {m === 'same' ? 'Same as Mac' : m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        {head(`Text size: ${eff.fontSize}px${p.fontSize ? '' : ' (same as Mac)'}`, p.fontSize ? { label: 'Same as Mac', onClick: () => setPhone('fontSize', undefined) } : null)}
        <input
          type="range"
          min={PHONE_TEXT_MIN}
          max={PHONE_TEXT_MAX}
          step={1}
          value={eff.fontSize}
          data-testid="phone-font-size"
          onChange={(e) => setPhone('fontSize', Number(e.target.value) === t.fontSize ? undefined : Number(e.target.value))}
        />
        <span className="small muted">Makes everything bigger together: chat, code, steps and the sidebar.</span>
      </div>
      <div className="field">
        {head(
          `Chat text: ${chatPx}px${p.chatFontSize === undefined ? ' (follows text size)' : ''}`,
          p.chatFontSize !== undefined ? { label: 'Follow text size', onClick: () => setPhone('chatFontSize', undefined) } : null,
        )}
        <input
          type="range"
          min={PHONE_TEXT_MIN}
          max={PHONE_TEXT_MAX + 2}
          step={1}
          value={chatPx}
          data-testid="phone-chat-size"
          onChange={(e) => setPhone('chatFontSize', Number(e.target.value))}
        />
      </div>
      <div className="field">
        {head(
          `Code: ${eff.codeFontSize}px${p.codeFontSize ? '' : ' (follows text size)'}`,
          p.codeFontSize ? { label: 'Follow text size', onClick: () => setPhone('codeFontSize', undefined) } : null,
        )}
        <input
          type="range"
          min={10}
          max={20}
          step={0.5}
          value={eff.codeFontSize}
          data-testid="phone-code-size"
          onChange={(e) => setPhone('codeFontSize', Number(e.target.value))}
        />
      </div>
      <div className="field">
        {head(
          `Line spacing: ${eff.lineHeight?.toFixed(2)}${p.lineHeight ? '' : ' (same as Mac)'}`,
          p.lineHeight ? { label: 'Same as Mac', onClick: () => setPhone('lineHeight', undefined) } : null,
        )}
        <input type="range" min={1.3} max={2} step={0.05} value={eff.lineHeight} onChange={(e) => setPhone('lineHeight', Number(e.target.value))} />
      </div>
      <div className="field">
        <label>Steps &amp; tool output size</label>
        <select
          className="select"
          value={p.stepsSize ?? ''}
          data-testid="phone-steps-size"
          onChange={(e) => setPhone('stepsSize', (e.target.value || undefined) as PhoneTheme['stepsSize'])}
        >
          <option value="">Same as Mac</option>
          {STEPS_SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {preview}
      {isSet && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn" data-testid="phone-reset" onClick={() => onChange({ ...theme, phone: {} })}>
            <RotateCcw size={13} /> Use the Mac's look on this phone
          </button>
        </div>
      )}
    </div>
  );
}
