import { Fragment } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ConfigOptionView } from '@shared/types';
import { boolValue, groupedChoices, isBooleanOption, isOn, optionPillLabel, toggleTooltip } from '@shared/acpConfig';
import '../acpConfig.css';

/**
 * Pill that is exactly as wide as the chosen value. A native <select> is laid over it (invisible), so the menu,
 * keyboard use and accessibility stay native. Grouped choices (e.g. models by provider) get `<optgroup>` headers.
 */
export function ConfigSelect({ option, disabled, title, onChange }: { option: ConfigOptionView; disabled?: boolean; title?: string; onChange: (v: string) => void }) {
  const current = option.options.find((x) => x.value === option.currentValue);
  const sections = groupedChoices(option);
  const item = (x: { value: string; name: string; description?: string }) => (
    <option key={x.value} value={x.value} title={x.description}>
      {optionPillLabel(option, x.name)}
    </option>
  );
  return (
    <label className={`pill mini-select ${disabled ? 'disabled' : ''}`} title={title ?? (option.description ? `${option.name} — ${option.description}` : option.name)} data-config-id={option.id}>
      <span className="pill-text">{optionPillLabel(option, current?.name ?? option.currentValue)}</span>
      <ChevronDown size={13} className="pill-caret" />
      <select value={option.currentValue} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={option.name}>
        {sections.map((s, i) =>
          s.group ? (
            <optgroup key={s.group.id} label={s.group.name}>
              {s.choices.map(item)}
            </optgroup>
          ) : (
            <Fragment key={`loose-${i}`}>{s.choices.map(item)}</Fragment>
          ),
        )}
      </select>
    </label>
  );
}

/** An on/off session setting (ACP boolean option): the setting's name with a small switch, never a bare "On"/"Off". */
export function ConfigToggle({ option, disabled, onChange }: { option: ConfigOptionView; disabled?: boolean; onChange: (v: string) => void }) {
  const on = isOn(option);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={option.name}
      className={`pill config-toggle ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
      disabled={disabled}
      title={toggleTooltip(option)}
      onClick={() => onChange(boolValue(!on))}
      data-config-id={option.id}
    >
      <span className="config-switch" aria-hidden="true">
        <span className="config-knob" />
      </span>
      <span className="pill-text">{option.name}</span>
    </button>
  );
}

/** One session setting as a pill: a toggle for on/off options, a dropdown otherwise. */
export function ConfigPill({ option, disabled, title, onChange }: { option: ConfigOptionView; disabled?: boolean; title?: string; onChange: (v: string) => void }) {
  return isBooleanOption(option) ? <ConfigToggle option={option} disabled={disabled} onChange={onChange} /> : <ConfigSelect option={option} disabled={disabled} title={title} onChange={onChange} />;
}
