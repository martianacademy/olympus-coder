import type { ConfigOptionView } from './types';

/**
 * Session settings beyond plain dropdowns (ACP `configOptions`): on/off toggles (`type: "boolean"`, e.g. Claude's
 * Fast mode) and dropdowns whose values come in named groups (e.g. models by provider).
 *
 * A boolean option keeps the same shape as a dropdown so every existing user of `ConfigOptionView` (saved
 * per-agent defaults, sub-session config, inherit / match by name) keeps working: its `currentValue` is the
 * string `'true'` or `'false'` and its `options` are On / Off. Only the wire format differs: `session/set_config_option`
 * and `session/new` `configOptions` send `{ type: 'boolean', value: <boolean> }` for it (src/main/acpConfig.ts).
 */
export type ConfigOptionKind = 'select' | 'boolean';

export const BOOL_TRUE = 'true';
export const BOOL_FALSE = 'false';

/** A choice of a dropdown; `group` is the id of the group it is listed under. */
export interface ConfigChoiceView {
  value: string;
  name: string;
  description?: string;
  group?: string;
}

export interface ConfigGroupView {
  id: string;
  name: string;
}

/** `ConfigOptionView` plus what toggles and grouped dropdowns need. Fields are optional: a plain dropdown has none. */
export interface AcpConfigOptionView extends ConfigOptionView {
  /** Absent = `select`. */
  type?: ConfigOptionKind;
  options: ConfigChoiceView[];
  /** Group headers, in the agent's order, when the choices come in groups. */
  groups?: ConfigGroupView[];
}

export const isBooleanOption = (o: ConfigOptionView): boolean => (o as AcpConfigOptionView).type === 'boolean';

/** `'true'` / `'false'` (and the usual spellings people and agents use) → boolean; anything else → undefined. */
export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (['true', 'on', '1', 'yes', 'enabled', 'enable'].includes(s)) return true;
  if (['false', 'off', '0', 'no', 'disabled', 'disable'].includes(s)) return false;
  return undefined;
}

export const boolValue = (b: boolean): string => (b ? BOOL_TRUE : BOOL_FALSE);

/** True when a boolean option is on. */
export const isOn = (o: ConfigOptionView): boolean => parseBool(o.currentValue) === true;

/** A dropdown's choices split by group, in the agent's order. Ungrouped choices come first under `group: undefined`. */
export function groupedChoices(o: ConfigOptionView): { group?: ConfigGroupView; choices: ConfigChoiceView[] }[] {
  const opt = o as AcpConfigOptionView;
  if (!opt.groups?.length) return [{ choices: opt.options }];
  const out: { group?: ConfigGroupView; choices: ConfigChoiceView[] }[] = [];
  const loose = opt.options.filter((c) => !c.group || !opt.groups!.some((g) => g.id === c.group));
  if (loose.length) out.push({ choices: loose });
  for (const g of opt.groups) {
    const choices = opt.options.filter((c) => c.group === g.id);
    if (choices.length) out.push({ group: g, choices });
  }
  return out;
}

/** Composer / home pill text. Model and mode values explain themselves; other settings show their name ("Effort: High"). */
export function optionPillLabel(o: ConfigOptionView, valueName: string): string {
  return o.category === 'model' || o.category === 'mode' ? valueName : `${o.name}: ${valueName}`;
}

/** Tooltip for a toggle pill: says what it is, its state, and what a click does. */
export function toggleTooltip(o: ConfigOptionView): string {
  const on = isOn(o);
  const what = o.description ? `${o.name} — ${o.description}` : o.name;
  return `${what}\n${o.name} is ${on ? 'on' : 'off'}. Click to turn it ${on ? 'off' : 'on'}.`;
}

// ------------------------------------------------------------------ MCP servers of one chat

/**
 * What the app knows about one MCP server it handed (or meant to hand) to a chat's agent session.
 *  - `sent`: given to the agent; the agent has not reported a problem (Claude and Codex only report failures).
 *  - `ready`: confirmed working (the agent called it, or reported it ready).
 *  - `failed` / `needs-auth` / `cancelled`: the agent reported it.
 *  - `skipped`: the agent ignored it (e.g. Codex already has a server with that name in its own config).
 *  - `dropped`: Olympus left it out after the agent refused to start a session with it.
 *  - `unsupported`: not sent, the agent can't use this transport.
 */
export type McpServerState = 'sent' | 'ready' | 'failed' | 'needs-auth' | 'cancelled' | 'skipped' | 'dropped' | 'unsupported';

export interface McpServerStatusView {
  name: string;
  /** `olympus` = the app's own session tools; `connector` = Settings → Connectors. */
  source: 'olympus' | 'connector';
  transport: 'stdio' | 'http' | 'sse' | 'acp';
  state: McpServerState;
  /** Why, in the agent's or the app's words (never contains secrets: built from names and agent messages). */
  reason?: string;
  at: number;
}

export interface McpChatStatus {
  threadId: string;
  agentId: string;
  servers: McpServerStatusView[];
  /** The agent can be served MCP over the ACP connection itself (`mcpCapabilities.acp`). */
  acpTransport?: boolean;
}

export const MCP_STATE_LABEL: Record<McpServerState, string> = {
  sent: 'Connected',
  ready: 'Ready',
  failed: 'Failed',
  'needs-auth': 'Needs sign-in',
  cancelled: 'Cancelled',
  skipped: 'Skipped by agent',
  dropped: 'Left out',
  unsupported: 'Not supported',
};

/** States that mean the server's tools are not available in the chat. */
export const MCP_PROBLEM_STATES: McpServerState[] = ['failed', 'needs-auth', 'cancelled', 'skipped', 'dropped', 'unsupported'];

// ------------------------------------------------------------------ model provider (ACP providers/*)

/** One provider slot of an agent (`providers/list`). `current` absent = disabled (the agent uses its own login). */
export interface ProviderSlotView {
  providerId: string;
  /** API types the slot accepts, e.g. anthropic / bedrock / vertex, openai. */
  supported: string[];
  required: boolean;
  current?: { apiType: string; baseUrl: string };
}

/** How the API key is sent to the provider. */
export type ProviderKeyHeader = 'authorization' | 'x-api-key' | 'api-key' | 'none';

/** The provider the user set in Olympus for one agent (the key itself stays in the encrypted secret store). */
export interface SavedProviderView {
  providerId: string;
  apiType: string;
  baseUrl: string;
  keyHeader: ProviderKeyHeader;
  hasKey: boolean;
  /** Vertex only (Claude): Google Cloud project and region. */
  vertex?: { projectId: string; region: string };
  appliedAt?: number;
  error?: string;
}

export interface AgentProvidersView {
  agentId: string;
  /** The agent was running, so `supported` is known (else the view was asked without starting it). */
  known: boolean;
  /** The agent advertises `agentCapabilities.providers`. */
  supported: boolean;
  slots: ProviderSlotView[];
  saved?: SavedProviderView;
  error?: string;
}

export interface ProviderInput {
  providerId: string;
  apiType: string;
  baseUrl: string;
  keyHeader: ProviderKeyHeader;
  /** Empty / absent = keep the saved key. */
  apiKey?: string;
  vertex?: { projectId: string; region: string };
}

// ------------------------------------------------------------------ login (ACP auth)

export interface AuthAccountView {
  label: string;
  description?: string;
  email?: string;
  organization?: string;
  plan?: string;
  active?: boolean;
}

/** `auth/status` / `auth/status_update` / Codex `_auth/status_update`, normalised. */
export interface AuthInfoView {
  state: 'authenticated' | 'unauthenticated' | 'not_required' | 'unknown';
  /** account / api_key / gateway / external … when the agent says how. */
  kind?: string;
  accounts: AuthAccountView[];
  at: number;
}

/** A variable a login method needs (ACP `env_var` methods, or an API-key method). */
export interface AuthVarView {
  name: string;
  label?: string;
  secret: boolean;
  optional: boolean;
}

/** A link the agent asked the user to open during a login (e.g. Codex device code), shown in the login dialog. */
export interface LoginLinkView {
  agentId: string;
  elicitationId?: string;
  url: string;
  message: string;
  at: number;
}

/** What the login dialog shows for one agent (IPC `acpConfig.authDetails`). */
export interface AuthDetailsView {
  agentId: string;
  methods: {
    id: string;
    name: string;
    description?: string;
    flow: 'terminal' | 'agent' | 'api-key' | 'env-vars';
    vars: AuthVarView[];
    link?: string;
  }[];
  /** Names of login variables that already have a saved value (values never leave the main process). */
  savedVars: string[];
  info?: AuthInfoView;
  link?: LoginLinkView;
  canLogout: boolean;
  /** The agent answers `auth/status` (else status only arrives as pushed updates, or not at all). */
  canCheckStatus: boolean;
}

/** Events of this slice (same `desk:event` channel as `DeskEvents`). */
export interface AcpConfigEvents {
  'mcp:status': McpChatStatus;
  'auth:info': { agentId: string; info: AuthInfoView };
  'auth:link': { agentId: string; link: LoginLinkView | null };
}
