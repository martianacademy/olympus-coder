import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { ConfigOptionView } from '@shared/types';
import { groupedChoices, optionPillLabel, type ConfigChoiceView } from '@shared/acpConfig';
import { choiceTags, providerOf, type ModelTag } from '@shared/modelTags';
import { useModelTags } from '../modelTags';

/**
 * The popup picker for settings with many choices (e.g. opencode's ~400 models): same pill as ConfigSelect, but
 * opens a panel with a search box, capability chips (Free / Vision / Reasoning / Tools, from the models.dev tags in
 * src/main/modelTags.ts), provider chips (from the "provider/model" value prefix) and a list half the screen high.
 */

// ------------------------------------------------------------------ the picker

const CAPS: { tag: ModelTag; label: string }[] = [
  { tag: 'free', label: 'Free' },
  { tag: 'vision', label: 'Vision' },
  { tag: 'reasoning', label: 'Reasoning' },
  { tag: 'tools', label: 'Tools' },
];
const PROVIDER_CAP = 8;
const GAP = 4;

export function ConfigSelectMenu({ option, disabled, title, onChange }: { option: ConfigOptionView; disabled?: boolean; title?: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caps, setCaps] = useState<ModelTag[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [allProviders, setAllProviders] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const registry = useModelTags();

  const current = option.options.find((x) => x.value === option.currentValue);
  const sections = useMemo(() => groupedChoices(option), [option]);
  const tagsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of option.options) m.set(c.value, choiceTags(registry?.tags, c.value, c.name));
    return m;
  }, [option.options, registry]);
  const providers = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of option.options) {
      const p = providerOf(c.value);
      if (p) seen.set(p, (seen.get(p) ?? 0) + 1);
    }
    // Most models first, so the cap keeps the big providers.
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [option.options]);
  const capsPresent = CAPS.filter((c) => option.options.some((x) => tagsOf.get(x.value)?.includes(c.tag)));

  const q = query.trim().toLowerCase();
  const visible = (c: ConfigChoiceView) =>
    (!q || c.value.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) &&
    (!provider || providerOf(c.value) === provider) &&
    caps.every((t) => tagsOf.get(c.value)?.includes(t));
  const shown = sections.map((s) => ({ ...s, choices: s.choices.filter(visible) })).filter((s) => s.choices.length);
  const flat = shown.flatMap((s) => s.choices);
  const activeValue = active && flat.some((c) => c.value === active) ? active : flat[0]?.value ?? null;

  /** Where the panel goes: below the pill when it fits better, else above (the composer sits at the bottom). */
  const placement = (): CSSProperties => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return { visibility: 'hidden' };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const phone = vw <= 600;
    const width = phone ? vw - 16 : Math.min(420, vw - 16);
    const left = phone ? 8 : Math.max(8, Math.min(r.left, vw - width - 8));
    const down = below >= Math.min(above, vh * 0.5 + 110);
    return down ? { left, width, top: r.bottom + GAP, maxHeight: below } : { left, width, bottom: vh - r.top + GAP, maxHeight: above };
  };
  const place = () => setPos(placement());

  const close = (refocus = true) => {
    setOpen(false);
    setQuery('');
    setActive(null);
    if (refocus) trigger.current?.focus();
  };
  const pick = (value: string) => {
    if (value !== option.currentValue) onChange(value);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    search.current?.focus();
    // Start the list at the chosen model.
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [open]);

  useEffect(() => {
    if (open && activeValue) list.current?.querySelector(`[data-value="${CSS.escape(activeValue)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeValue, open]);

  const onKey = (e: React.KeyboardEvent) => {
    // The panel is portalled, but React still bubbles its events to the composer: keep Enter / Esc here.
    if (['Escape', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      const i = flat.findIndex((c) => c.value === activeValue);
      const next = e.key === 'ArrowDown' ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1);
      setActive(flat[next].value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeValue) pick(activeValue);
    }
  };

  const toggleCap = (t: ModelTag) => setCaps((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]));
  const providerChips = allProviders || providers.length <= PROVIDER_CAP + 1 ? [...providers] : providers.slice(0, PROVIDER_CAP);
  if (provider && !providerChips.includes(provider)) providerChips.push(provider);
  const filtering = Boolean(q || caps.length || provider);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`pill mini-select ${disabled ? 'disabled' : ''}`}
        title={title ?? (option.description ? `${option.name} — ${option.description}` : option.name)}
        data-config-id={option.id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={option.name}
        disabled={disabled}
        onClick={() => (open ? close() : (setPos(placement()), setOpen(true)))}
      >
        <span className="pill-text">{optionPillLabel(option, current?.name ?? option.currentValue)}</span>
        <ChevronDown size={13} className="pill-caret" />
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="menu config-menu" style={pos} data-testid="config-menu" data-config-id={option.id} onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
            <input
              ref={search}
              className="config-menu-search"
              placeholder={`Search ${option.options.length} ${option.category === 'model' ? 'models' : 'choices'}…`}
              value={query}
              onChange={(e) => (setQuery(e.target.value), setActive(null))}
              aria-label={`Search ${option.name}`}
              aria-controls={`config-menu-list-${option.id}`}
              spellCheck={false}
            />
            {(capsPresent.length > 0 || providers.length > 1) && (
              <div className="config-menu-chips">
                {capsPresent.map((c) => (
                  <button key={c.tag} type="button" className={`config-chip ${caps.includes(c.tag) ? 'on' : ''}`} aria-pressed={caps.includes(c.tag)} data-chip={c.tag} onClick={() => (toggleCap(c.tag), setActive(null))}>
                    {c.label}
                  </button>
                ))}
                {capsPresent.length > 0 && providers.length > 1 && <span className="config-chip-sep" aria-hidden="true" />}
                {providers.length > 1 && (
                  <>
                    <button type="button" className={`config-chip ${provider ? '' : 'on'}`} aria-pressed={!provider} data-chip="provider:all" onClick={() => (setProvider(null), setActive(null))}>
                      All
                    </button>
                    {providerChips.map((p) => (
                      <button key={p} type="button" className={`config-chip ${provider === p ? 'on' : ''}`} aria-pressed={provider === p} data-chip={`provider:${p}`} onClick={() => (setProvider(provider === p ? null : p), setActive(null))}>
                        {p}
                      </button>
                    ))}
                    {providers.length > providerChips.length && (
                      <button type="button" className="config-chip more" data-chip="provider:more" onClick={() => setAllProviders(true)}>
                        +{providers.length - providerChips.length}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <div ref={list} className="config-menu-list" role="listbox" id={`config-menu-list-${option.id}`} aria-label={option.name}>
              {shown.map((s, i) => (
                <div key={s.group?.id ?? `loose-${i}`} role="group" aria-label={s.group?.name}>
                  {s.group && <div className="config-menu-group">{s.group.name}</div>}
                  {s.choices.map((c) => {
                    const sel = c.value === option.currentValue;
                    return (
                      <div
                        key={c.value}
                        role="option"
                        aria-selected={sel}
                        data-value={c.value}
                        className={`config-menu-row ${c.value === activeValue ? 'active' : ''} ${sel ? 'selected' : ''}`}
                        title={c.description ?? c.value}
                        onMouseMove={() => c.value !== activeValue && setActive(c.value)}
                        onClick={() => pick(c.value)}
                      >
                        <span className="config-menu-name">{optionPillLabel(option, c.name)}</span>
                        {tagsOf.get(c.value)?.includes('free') && <span className="config-menu-tag">Free</span>}
                        <span className="config-menu-check">{sel && <Check size={13} />}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {!flat.length && <div className="config-menu-empty">No match{filtering ? ' — clear the search or chips' : ''}</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
