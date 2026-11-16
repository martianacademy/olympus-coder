import { boolValue, isBooleanOption, parseBool, type AcpConfigOptionView, type ConfigChoiceView, type ConfigGroupView } from '@shared/acpConfig';
import type { ConfigOptionView } from '@shared/types';

/**
 * ACP session settings (`configOptions`, unstable SDK 2.6.0): mapping the agent's options to the app's view, and
 * the wire format back. Pure functions (no Electron, no connection), so agents.ts, acpSessionService.ts and the unit
 * tests (tests/acpConfig.unit.mjs) share them.
 *
 *  - `select`: a dropdown. `options` is either a flat list or a list of groups `{ group, name, options }`; groups are
 *    kept (`groups` + each choice's `group`) so the dropdown can show headers.
 *  - `boolean`: an on/off toggle. Agents only send these to clients that advertise
 *    `clientCapabilities.session.configOptions.boolean` (claude-agent-acp `session-config-options.js`), so
 *    `CONFIG_SESSION_CAPS` must be merged into `initialize`. In the app's view its value is `'true'` / `'false'`.
 *  - Agents that use the older `modes` instead get a `__mode` dropdown (`session/set_mode`, `current_mode_update`).
 */

/** Merge into `clientCapabilities.session` on `initialize`. */
export const CONFIG_SESSION_CAPS = { configOptions: { boolean: {} } } as const;

/** The legacy-mode pseudo option id (`session/set_mode`). */
export const LEGACY_MODE_ID = '__mode';

const BOOL_CHOICES: ConfigChoiceView[] = [
  { value: 'true', name: 'On' },
  { value: 'false', name: 'Off' },
];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function choiceOf(x: any, group?: string): ConfigChoiceView | null {
  if (!x || (typeof x.value !== 'string' && typeof x.value !== 'number')) return null;
  const c: ConfigChoiceView = { value: String(x.value), name: str(x.name) ?? String(x.value) };
  if (str(x.description)) c.description = x.description;
  if (group !== undefined) c.group = group;
  return c;
}

/** One agent option → the app's view; `null` for types the app doesn't know (skipped, never guessed). */
export function mapConfigOption(o: any): AcpConfigOptionView | null {
  if (!o || typeof o.id !== 'string' || !o.id) return null;
  const base = {
    id: o.id,
    name: str(o.name) ?? o.id,
    ...(str(o.description) ? { description: o.description } : {}),
    ...(str(o.category) ? { category: o.category } : {}),
  };
  if (o.type === 'boolean') {
    const v = parseBool(o.currentValue);
    return { ...base, type: 'boolean', currentValue: boolValue(v ?? false), options: BOOL_CHOICES.map((c) => ({ ...c })) };
  }
  if (o.type !== 'select' && o.type !== undefined) return null;
  const raw: any[] = Array.isArray(o.options) ? o.options : [];
  const groups: ConfigGroupView[] = [];
  const options: ConfigChoiceView[] = [];
  for (const x of raw) {
    if (x && Array.isArray(x.options)) {
      const id = String(x.group ?? x.id ?? x.name ?? `group-${groups.length}`);
      groups.push({ id, name: str(x.name) ?? id });
      for (const y of x.options) {
        const c = choiceOf(y, id);
        if (c) options.push(c);
      }
    } else {
      const c = choiceOf(x);
      if (c) options.push(c);
    }
  }
  const view: AcpConfigOptionView = { ...base, type: 'select', currentValue: o.currentValue == null ? '' : String(o.currentValue), options };
  if (groups.length) view.groups = groups;
  return view;
}

/** The agent's `configOptions` → the app's view (selects and toggles, groups kept). */
export function mapConfigOptions(opts: any[] | null | undefined): AcpConfigOptionView[] {
  return (Array.isArray(opts) ? opts : []).map(mapConfigOption).filter((o): o is AcpConfigOptionView => o !== null);
}

/** Older agents report modes outside `configOptions`; show them as a `__mode` dropdown. */
export function legacyOptions(res: any): AcpConfigOptionView[] {
  const modes = res?.modes;
  if (!modes?.availableModes?.length) return [];
  return [
    {
      id: LEGACY_MODE_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: String(modes.currentModeId ?? ''),
      options: modes.availableModes.map((m: any) => ({ value: String(m.id), name: str(m.name) ?? String(m.id), ...(str(m.description) ? { description: m.description } : {}) })),
    },
  ];
}

/** A setup answer (`session/new|load|resume|options`) → options: `configOptions` when present, else legacy modes. */
export function configView(res: any): AcpConfigOptionView[] {
  return res?.configOptions?.length ? mapConfigOptions(res.configOptions) : legacyOptions(res);
}

/** Is `value` (the app's string form) a valid value for this option? */
export function acceptsValue(o: ConfigOptionView, value: string): boolean {
  if (isBooleanOption(o)) return parseBool(value) !== undefined;
  return o.options.some((x) => x.value === value);
}

/** The app's string form of a value for this option (booleans normalised to `'true'` / `'false'`). */
export function normalizeValue(o: ConfigOptionView | undefined, value: string): string {
  if (o && isBooleanOption(o)) {
    const b = parseBool(value);
    return b === undefined ? value : boolValue(b);
  }
  return value;
}

/** The value part of `session/set_config_option` / an initial option: `{ type: 'boolean', value }` for toggles. */
export function wireValue(o: ConfigOptionView | undefined, value: string): { type: 'boolean'; value: boolean } | { value: string } {
  if (o && isBooleanOption(o)) {
    const b = parseBool(value);
    if (b === undefined) throw new Error(`${o.name} is an on/off setting; "${value}" is not on or off.`);
    return { type: 'boolean', value: b };
  }
  return { value };
}

export type ConfigRequest =
  | { method: 'session/set_mode'; params: { sessionId: string; modeId: string } }
  | { method: 'session/set_config_option'; params: { sessionId: string; configId: string; type?: 'boolean'; value: string | boolean } };

/** The request that sets one option: `session/set_mode` for the legacy `__mode`, else `session/set_config_option`. */
export function configRequest(sessionId: string, options: ConfigOptionView[], configId: string, value: string): ConfigRequest {
  if (configId === LEGACY_MODE_ID) return { method: 'session/set_mode', params: { sessionId, modeId: value } };
  const o = options.find((x) => x.id === configId);
  return { method: 'session/set_config_option', params: { sessionId, configId, ...wireValue(o, value) } };
}

/** Options after a set: the agent's answer when it sent the full list, else the old list with the one value changed. */
export function afterSet(options: ConfigOptionView[], configId: string, value: string, response: any): AcpConfigOptionView[] {
  if (configId !== LEGACY_MODE_ID && Array.isArray(response?.configOptions)) return mapConfigOptions(response.configOptions);
  return options.map((o) => (o.id === configId ? { ...o, currentValue: normalizeValue(o, value) } : o)) as AcpConfigOptionView[];
}

/**
 * `configOptions` for `session/new` from the user's saved defaults. The type of each option comes from `known`
 * (the options last seen for this agent): a saved value whose option is unknown, or that the known option would
 * reject, is left out (it is applied after the session starts, when the options are known). `__…` keys are app
 * settings, never sent.
 */
export function initialConfigOptions(saved: Record<string, string> | undefined, known: ConfigOptionView[]): ({ configId: string } & ({ type: 'boolean'; value: boolean } | { value: string }))[] {
  const out: ({ configId: string } & ({ type: 'boolean'; value: boolean } | { value: string }))[] = [];
  for (const [configId, value] of Object.entries(saved ?? {})) {
    if (configId.startsWith('__') || typeof value !== 'string') continue;
    const o = known.find((x) => x.id === configId);
    if (!o) {
      // Without a known option the type is a guess; only a value that can't be a toggle is safe as a select value.
      if (parseBool(value) === undefined) out.push({ configId, value });
      continue;
    }
    if (!acceptsValue(o, value)) continue;
    out.push({ configId, ...wireValue(o, value) });
  }
  return out;
}

/**
 * Saved defaults to apply after a new session started (those it doesn't already have): `[configId, value]` pairs
 * in the app's string form. `__mode` is the legacy mode; other `__…` keys are app settings.
 */
export function defaultsToApply(saved: Record<string, string> | undefined, options: ConfigOptionView[]): [string, string][] {
  const out: [string, string][] = [];
  for (const [id, raw] of Object.entries(saved ?? {})) {
    if (id.startsWith('__') && id !== LEGACY_MODE_ID) continue;
    const o = options.find((x) => x.id === id);
    if (!o || typeof raw !== 'string' || !acceptsValue(o, raw)) continue;
    const value = normalizeValue(o, raw);
    if (o.currentValue !== value) out.push([id, value]);
  }
  return out;
}

/** `current_mode_update`: the mode option(s) follow the agent's mode. */
export function withCurrentMode(options: ConfigOptionView[], modeId: string): ConfigOptionView[] {
  return options.map((o) => (o.category === 'mode' || o.id === LEGACY_MODE_ID ? { ...o, currentValue: String(modeId) } : o));
}

/** A user / orchestrator value for an option, matched loosely (value, name, unique substring; on/off for toggles). */
export function matchChoice(opt: ConfigOptionView, rawValue: string): { value: string; name: string } | undefined {
  if (isBooleanOption(opt)) {
    const b = parseBool(rawValue);
    return b === undefined ? undefined : opt.options.find((x) => x.value === boolValue(b));
  }
  const wanted = rawValue.trim();
  const lc = wanted.toLowerCase();
  const exact = opt.options.find((x) => x.value === wanted);
  if (exact) return exact;
  const ci = opt.options.find((x) => x.value.toLowerCase() === lc || x.name.toLowerCase() === lc);
  if (ci) return ci;
  const sub = opt.options.filter((x) => x.value.toLowerCase().includes(lc) || x.name.toLowerCase().includes(lc));
  return sub.length === 1 ? sub[0] : undefined;
}
