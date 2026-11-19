import type { AuthAccountView, AuthInfoView, AuthVarView, LoginLinkView } from '@shared/acpConfig';
import { CLI_ENV_FALLBACKS, CLI_TERMINAL_LOGINS, KNOWN_KEY_VARS, METHOD_ID_VAR, PURE_ACP_WRAPPERS } from './acpAuthCatalog';

/**
 * ACP login, beyond what the SDK schema types: every auth method shape agents send, the status they report,
 * links they ask the user to open during a login, and interactive CLI / env-var fallbacks for registry agents
 * whose ACP servers omit `type: 'terminal'` (e.g. Goose `goose-provider`, Kilo `kilo-login`, OpenCode
 * `opencode-login`), omit API-key methods, or advertise `authMethods: []` while requiring CLI sign-in.
 */

export type AuthFlow = 'terminal' | 'agent' | 'api-key' | 'env-vars' | 'gateway';

const RAW_AUTH_METHOD_META = 'olympusCoder.rawAuthMethod';

export interface AuthMethodDetail {
  id: string;
  name: string;
  description?: string;
  flow: AuthFlow;
  /** Variables the user enters (api-key: one secret; env-vars: as the agent lists them). */
  vars: AuthVarView[];
  /** The key goes to the agent in `authenticate` `_meta['api-key'].apiKey` (Codex) as well as in its env. */
  keyInMeta?: boolean;
  /** A page that explains where to get the key, when the agent gives one. */
  link?: string;
  /** Synthesized Olympus env-var setup (save secrets + restart agent; skip `authenticate` RPC). */
  synthetic?: boolean;
  /** Terminal CLI login arguments (replaces trailing ACP server flags when `replaceAgentArgs` is true). */
  terminalArgs?: string[];
  terminalEnv?: Record<string, string>;
  replaceAgentArgs?: boolean;
}

export interface AgentAuthMeta {
  builtin?: boolean;
  registryId?: string;
  command?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Restores any fields stripped by `@agentclientprotocol/sdk`'s `zInitializeResponse` Zod parser. */
export function unwrapAuthMethod(m: any): any {
  const raw = m?._meta?.[RAW_AUTH_METHOD_META];
  return raw && typeof raw === 'object' ? raw : m;
}

function varFromMethodId(id: string): string | undefined {
  for (const [re, name] of METHOD_ID_VAR) if (re.test(id)) return name;
  return undefined;
}

/**
 * Detects ACP auth methods that instruct the user to run a CLI command in a terminal (such as
 * `Run \`kilo auth login\` in the terminal`, `Run \`opencode auth login\` in the terminal`, or
 * `Run \`goose configure\`...`) while omitting `type: 'terminal'`, and extracts the CLI subcommand args.
 */
function terminalArgsFromPrompt(id: string, name: string, description?: string): string[] | null {
  const text = `${name} ${description ?? ''}`;
  if (id === 'goose-provider' || /\brun\s+`?goose\s+configure`?/i.test(text)) return ['configure'];
  const backtick = /\brun\s+`([^`\r\n;|&$><]+)`/i.exec(text);
  if (!backtick) return null;
  const tokens = backtick[1].trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens[0].startsWith('-') || !/^[a-z0-9@_./-]+$/i.test(tokens[0])) return null;
  return tokens.slice(1);
}

/** One raw `authMethods` entry → what the login dialog needs. */
export function authMethodDetail(agentId: string, rawInput: any): AuthMethodDetail {
  const m = unwrapAuthMethod(rawInput);
  const base = { id: String(m?.id ?? ''), name: str(m?.name) ?? String(m?.id ?? 'Login'), ...(str(m?.description) ? { description: m.description.trim() } : {}) };
  if (m?.type === 'terminal') {
    return {
      ...base,
      flow: 'terminal',
      vars: [],
      terminalArgs: Array.isArray(m.args) ? m.args.map(String) : [],
      ...(m.env && typeof m.env === 'object' ? { terminalEnv: m.env } : {}),
    };
  }
  if (m?.type === 'env_var' || Array.isArray(m?.vars)) {
    const vars: AuthVarView[] = (Array.isArray(m?.vars) ? m.vars : [])
      .filter((v: any) => str(v?.name))
      .map((v: any) => ({ name: v.name.trim(), ...(str(v.label) ? { label: v.label.trim() } : {}), secret: v.secret !== false, optional: v.optional === true }));
    if (vars.length) return { ...base, flow: 'env-vars', vars, ...(str(m?.link) ? { link: m.link.trim() } : {}) };
  }
  const inferredTerminalArgs = terminalArgsFromPrompt(base.id, base.name, base.description);
  if (inferredTerminalArgs !== null) {
    return { ...base, flow: 'terminal', vars: [], terminalArgs: inferredTerminalArgs, replaceAgentArgs: true };
  }
  if (m?._meta?.gateway) return { ...base, flow: 'gateway', vars: [] };
  const metaKey = m?._meta?.['api-key'];
  if (metaKey || /api.?key/i.test(base.id)) {
    const name = KNOWN_KEY_VARS[agentId] ?? varFromMethodId(base.id) ?? (metaKey?.provider === 'openai' ? 'OPENAI_API_KEY' : undefined);
    if (name) return { ...base, flow: 'api-key', vars: [{ name, label: 'API key', secret: true, optional: false }], ...(metaKey ? { keyInMeta: true } : {}) };
  }
  return { ...base, flow: 'agent', vars: [] };
}

/** Methods shown in the login dialog from the agent's own `authMethods`: gateway logins are left out. */
export const visibleMethods = (agentId: string, raw: any[] | undefined): AuthMethodDetail[] =>
  (Array.isArray(raw) ? raw : []).map((m) => authMethodDetail(agentId, m)).filter((m) => m.id && m.flow !== 'gateway');

/**
 * Complete list of login methods for an agent: its advertised ACP methods plus interactive CLI terminal login
 * and environment-variable key setup for non-builtin registry/custom CLI providers that omit them over ACP.
 */
export function effectiveAuthMethods(agentId: string, raw: any[] | undefined, meta?: AgentAuthMeta): AuthMethodDetail[] {
  const base = visibleMethods(agentId, raw);
  if (!meta || meta.builtin) return base;
  const out = [...base];
  const key = meta.registryId || agentId;

  if (!out.some((m) => m.flow === 'terminal')) {
    const cli = CLI_TERMINAL_LOGINS[key];
    if (cli) {
      out.push({
        id: '__olympus_cli_login',
        name: cli.name,
        description: cli.description,
        flow: 'terminal',
        vars: [],
        terminalArgs: cli.args,
        replaceAgentArgs: true,
        synthetic: true,
      });
    } else if (!PURE_ACP_WRAPPERS.has(key) && meta.command && !/-acp(?:\.exe)?$/i.test(meta.command)) {
      out.push({
        id: '__olympus_cli_login',
        name: 'Open CLI in terminal',
        description: 'Launches this CLI interactively in a terminal so you can complete its sign-in or setup prompt.',
        flow: 'terminal',
        vars: [],
        terminalArgs: [],
        replaceAgentArgs: true,
        synthetic: true,
      });
    }
  }

  if (!out.some((m) => m.flow === 'api-key' || m.flow === 'env-vars')) {
    const envFallback = CLI_ENV_FALLBACKS[key];
    if (envFallback) {
      out.push({
        id: '__olympus_env_vars',
        name: envFallback.name,
        ...(envFallback.description ? { description: envFallback.description } : {}),
        ...(envFallback.link ? { link: envFallback.link } : {}),
        flow: envFallback.vars.length === 1 ? 'api-key' : 'env-vars',
        vars: envFallback.vars.map((v) => ({ ...v })),
        synthetic: true,
      });
    } else {
      const singleVar = KNOWN_KEY_VARS[key];
      out.push({
        id: '__olympus_env_vars',
        name: singleVar ? `API key (${singleVar})` : 'Provider API key (environment)',
        description: 'Saves key(s) encrypted in your system keychain and passes them to the CLI environment.',
        flow: singleVar ? 'api-key' : 'env-vars',
        vars: singleVar
          ? [{ name: singleVar, label: 'API key', secret: true, optional: false }]
          : [
              { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
              { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
              { name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: true },
              { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
            ],
        synthetic: true,
      });
    }
  }
  return out;
}

/** `authenticate` params for a method; an API-key method also gets the key in `_meta` when the agent reads it there. */
export function authenticateParams(method: AuthMethodDetail, values: Record<string, string> = {}): any {
  if (method.flow === 'terminal') throw new Error('A terminal login runs in the terminal, not through authenticate.');
  const params: any = { methodId: method.id };
  if (method.keyInMeta && method.vars[0] && values[method.vars[0].name]) params._meta = { 'api-key': { apiKey: values[method.vars[0].name] } };
  return params;
}

/** Missing required variables of a method, by label. When every variable is optional (any-provider key form), at least one secret key must be provided. */
export function missingVars(method: AuthMethodDetail, values: Record<string, string>): string[] {
  if (method.vars.length > 0 && method.vars.every((v) => v.optional)) {
    const keyPool = method.vars.filter((v) => v.secret);
    const pool = keyPool.length > 0 ? keyPool : method.vars;
    return pool.some((v) => values[v.name]?.trim()) ? [] : ['at least one API key'];
  }
  return method.vars.filter((v) => !v.optional && !values[v.name]?.trim()).map((v) => v.label ?? v.name);
}

/** Secret store key of one login variable (the same key agents.ts already uses for API keys). */
export const authVarKey = (agentId: string, name: string) => `${agentId}:${name}`;

/** Builds CLI arguments for interactive terminal login, keeping `npx`/`uvx` package prefixes while stripping `acp` flags. */
export function cliLoginArgs(command: string, agentArgs: string[], loginArgs: string[]): string[] {
  const bin = command.replace(/\\/g, '/').split('/').pop()?.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase() ?? '';
  if (bin === 'npx') {
    const prefix =
      agentArgs[0] === '-y' || agentArgs[0] === '--yes'
        ? agentArgs.slice(0, 2)
        : (agentArgs[0] === '-p' || agentArgs[0] === '--package') && agentArgs.length >= 3
          ? agentArgs.slice(0, 3)
          : agentArgs.slice(0, 1);
    return [...prefix, ...loginArgs];
  }
  if (bin === 'uvx') {
    const prefix = agentArgs[0] === '--from' && agentArgs.length >= 3 ? agentArgs.slice(0, 3) : agentArgs.slice(0, 1);
    return [...prefix, ...loginArgs];
  }
  return [...loginArgs];
}

/** Env for the agent process: every saved variable of its methods (multi-variable `env_var` methods included). */
export function envForMethods(agentId: string, raw: any[] | undefined, getSecret: (k: string) => string | undefined, meta?: AgentAuthMeta): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of effectiveAuthMethods(agentId, raw, meta)) {
    for (const v of m.vars) {
      const val = getSecret(authVarKey(agentId, v.name));
      if (val) env[v.name] = val;
    }
  }
  return env;
}

// ------------------------------------------------------------------ status

const STATES = new Set(['authenticated', 'unauthenticated', 'not_required', 'unknown']);

function account(a: any): AuthAccountView | null {
  const label = str(a?.label) ?? str(a?.email) ?? str(a?.name);
  if (!label) return null;
  const meta = a?._meta?.claudeCode ?? {};
  return {
    label,
    ...(str(a.description) ? { description: a.description.trim() } : {}),
    ...(str(a.email) ? { email: a.email.trim() } : {}),
    ...(str(a.organization) ? { organization: a.organization.trim() } : {}),
    ...(str(meta.plan) ?? str(a.plan) ? { plan: str(meta.plan) ?? str(a.plan) } : {}),
    ...(typeof a.active === 'boolean' ? { active: a.active } : {}),
  };
}

/**
 * `auth/status` answers, `auth/status_update` and `_auth/status_update` params → one view, or null when the
 * payload is not a status. Codex `kind: 'none'` means logged out; any other kind means logged in that way.
 */
export function parseAuthStatus(p: any, now = Date.now()): AuthInfoView | null {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.state === 'string') {
    const accounts = (Array.isArray(p.accounts) ? p.accounts : []).map(account).filter(Boolean) as AuthAccountView[];
    const kind = str(p.accounts?.find?.((a: any) => a?.active)?._meta?.claudeCode?.kind ?? p.accounts?.[0]?._meta?.claudeCode?.kind);
    return { state: (STATES.has(p.state) ? p.state : 'unknown') as AuthInfoView['state'], ...(kind ? { kind } : {}), accounts, at: now };
  }
  const s = p.authStatus ?? (typeof p.kind === 'string' ? p : undefined);
  if (!s || typeof s.kind !== 'string') return null;
  if (s.kind === 'none' || s.kind === 'unauthenticated') return { state: 'unauthenticated', accounts: [], at: now };
  const acc = account({ label: s.label ?? s.account?.email, email: s.account?.email, plan: s.account?.plan, description: s.detail, active: true });
  return { state: 'authenticated', kind: s.kind, accounts: acc ? [acc] : [], at: now };
}

/** The account to show ("Signed in as …"): the active one, else the first. */
export const activeAccount = (info: AuthInfoView | undefined): AuthAccountView | undefined => info?.accounts.find((a) => a.active) ?? info?.accounts[0];

// ------------------------------------------------------------------ links during a login (Codex device code)

type Answer = { action: 'accept' } | { action: 'decline' } | { action: 'cancel' };

/**
 * A request-scoped URL elicitation (no `sessionId`) that arrives while the user is logging in to that agent is
 * part of the login: the login dialog shows the message (e.g. the device code) and the link. Without this,
 * elicitation.ts cancels it (no chat to ask in) and Codex's "ChatGPT (device code)" login fails.
 */
export class LoginLinks {
  private loggingIn = new Map<string, number>();
  private open = new Map<string, { link: LoginLinkView; resolve?: (a: Answer) => void }>();

  private emit: (agentId: string, link: LoginLinkView | null) => void;
  constructor(emit: (agentId: string, link: LoginLinkView | null) => void = () => {}) {
    this.emit = emit;
  }

  /** Wrap an `authenticate` call: links that arrive meanwhile belong to this login. */
  async during<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    this.loggingIn.set(agentId, (this.loggingIn.get(agentId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.loggingIn.get(agentId) ?? 1) - 1;
      if (n > 0) this.loggingIn.set(agentId, n);
      else this.loggingIn.delete(agentId);
      this.answer(agentId, { action: 'cancel' });
      this.clear(agentId);
    }
  }

  /** Is this `elicitation/create` part of a login in progress for `agentId`? */
  handles(agentId: string, params: any): boolean {
    return this.loggingIn.has(agentId) && !params?.sessionId && params?.mode === 'url' && typeof params?.url === 'string' && /^https?:\/\//i.test(params.url);
  }

  /** The `elicitation/create` handler for such a request: resolves when the user opens the link or closes the dialog. */
  request(agentId: string, params: any, signal?: AbortSignal): Promise<Answer> {
    this.answer(agentId, { action: 'cancel' });
    this.clear(agentId);
    const link: LoginLinkView = {
      agentId,
      url: params.url,
      message: str(params.message) ?? 'Open this link to finish logging in.',
      ...(str(params.elicitationId) ? { elicitationId: params.elicitationId } : {}),
      at: Date.now(),
    };
    return new Promise<Answer>((resolve) => {
      this.open.set(agentId, { link, resolve });
      this.emit(agentId, link);
      signal?.addEventListener('abort', () => this.answer(agentId, { action: 'cancel' }), { once: true });
    });
  }

  current(agentId: string): LoginLinkView | undefined {
    return this.open.get(agentId)?.link;
  }

  /**
   * The user opened the link (accept: the link and its message, e.g. a device code, stay shown until the login
   * ends) or closed the dialog (decline / cancel).
   */
  answer(agentId: string, a: Answer) {
    const o = this.open.get(agentId);
    if (!o) return;
    const resolve = o.resolve;
    o.resolve = undefined;
    resolve?.(a);
    if (a.action !== 'accept') this.clear(agentId);
  }

  private clear(agentId: string) {
    if (!this.open.delete(agentId)) return;
    this.emit(agentId, null);
  }

  /** `elicitation/complete` for a login link: the flow behind it finished. Returns true when it was one. */
  complete(elicitationId: string | undefined): boolean {
    if (!elicitationId) return false;
    for (const [agentId, o] of this.open) {
      if (o.link.elicitationId === elicitationId) {
        this.answer(agentId, { action: 'accept' });
        this.clear(agentId);
        return true;
      }
    }
    return false;
  }
}
