import type { AcpConfigEvents, AgentProvidersView, AuthDetailsView, AuthInfoView, McpChatStatus, ProviderInput } from '@shared/acpConfig';
import {
  authenticateParams,
  authVarKey,
  cliLogoutArgsFor,
  cliSwitchArgsFor,
  effectiveAuthMethods,
  LoginLinks,
  missingVars,
  parseAuthStatus,
  type AgentAuthMeta,
} from './acpAuth';
import { AcpMcpServing, McpStatusStore } from './acpMcp';
import { ProviderService, type ProviderRequester, type ProviderSecrets } from './acpProviders';

/**
 * The app's side of ACP config, MCP status, model providers and login details: what Settings, the workbench
 * info panel and the login dialog ask for. The agent processes come from a host that agents.ts registers
 * (`setAcpConfigHost`); secrets and events are injected by index.ts. No Electron imports (unit-testable).
 */

export interface AcpConfigHost {
  /** The agent's connection and `agentCapabilities`; `start` starts its process when it is not running. */
  connection(agentId: string, start: boolean): Promise<{ conn: ProviderRequester; caps: any } | null>;
  /** The raw `authMethods` of the agent's last `initialize` (empty before it ran). */
  rawAuthMethods(agentId: string): any[];
  /** Restart the agent process (new env) and wait until it answered `initialize`. */
  restartAgent(agentId: string): Promise<void>;
  /** Optional metadata about how the agent is defined (builtin vs registry/custom CLI). */
  agentMeta?(agentId: string): AgentAuthMeta | undefined;
  /** Optional list of already-saved env variable names for this agent. */
  savedVarNames?(agentId: string): string[];
  /** Optional callback invoked when credentials were saved and applied. */
  markAuthenticated?(agentId: string): void;
}

export interface AcpConfigDeps {
  secrets: ProviderSecrets;
  emit: <K extends keyof AcpConfigEvents>(channel: K, payload: AcpConfigEvents[K]) => void;
}

let deps: AcpConfigDeps | undefined;
let host: AcpConfigHost | undefined;
const authInfo = new Map<string, AuthInfoView>();

const emit: AcpConfigDeps['emit'] = (channel, payload) => deps?.emit(channel, payload);

/** MCP servers per chat (agents.ts: `begin` after a session started, `apply` from session updates). */
export const mcpStatus = new McpStatusStore((s) => emit('mcp:status', s));
/** Links an agent asks the user to open during a login (agents.ts: elicitation handler + `authenticate`). */
export const loginLinks = new LoginLinks((agentId, link) => emit('auth:link', { agentId, link }));
/** The `olympus` tools over `mcp/message` for agents with `mcpCapabilities.acp` (orchestrator.ts sets the rpc). */
export const acpMcp = new AcpMcpServing({ onCall: (threadId, name) => mcpStatus.markReady(threadId, name) });

let providers: ProviderService | undefined;

export function initAcpConfigService(d: AcpConfigDeps) {
  deps = d;
}

export function setAcpConfigHost(h: AcpConfigHost) {
  host = h;
}

function need() {
  if (!deps || !host) throw new Error('Agent settings are not ready yet.');
  return { deps, host };
}

function providerService(): ProviderService {
  const { deps, host } = need();
  providers ??= new ProviderService(deps.secrets, { connection: (id, start) => host.connection(id, start) });
  return providers;
}

// ------------------------------------------------------------------ MCP status

export const mcpStatusFor = (threadId: string): McpChatStatus | null => mcpStatus.get(threadId) ?? null;

// ------------------------------------------------------------------ providers

export const providersView = (agentId: string, start = true): Promise<AgentProvidersView> => providerService().view(agentId, start);
export const setProvider = (agentId: string, input: ProviderInput) => providerService().set(agentId, input);
export const disableProvider = (agentId: string, providerId?: string) => providerService().disable(agentId, providerId);
/** agents.ts, right after `initialize`: send the saved provider again. Returns the agent's refusal, if any. */
export async function reapplyProvider(agentId: string, conn: ProviderRequester, caps: any): Promise<string | undefined> {
  if (!deps || !host) return undefined;
  return providerService().reapply(agentId, conn, caps);
}

// ------------------------------------------------------------------ login

/** agents.ts: every `auth/status` answer, `auth/status_update` and `_auth/status_update`. Returns the parsed view. */
export function noteAuthStatus(agentId: string, params: any): AuthInfoView | null {
  const info = parseAuthStatus(params);
  if (!info) return null;
  authInfo.set(agentId, info);
  emit('auth:info', { agentId, info });
  return info;
}

export const authInfoFor = (agentId: string): AuthInfoView | undefined => authInfo.get(agentId);

export async function authDetails(agentId: string): Promise<AuthDetailsView> {
  const { deps, host } = need();
  const c = await host.connection(agentId, true).catch(() => null);
  const meta = host.agentMeta?.(agentId);
  const methods = effectiveAuthMethods(agentId, host.rawAuthMethods(agentId), meta);
  const fromMethods = methods.flatMap((m) => m.vars.map((v) => v.name)).filter((n) => Boolean(deps.secrets.getSecret(authVarKey(agentId, n))));
  const savedVars = [...new Set([...fromMethods, ...(host.savedVarNames?.(agentId) ?? [])])];
  if (c?.caps?.auth?.status && !authInfo.has(agentId)) {
    try {
      noteAuthStatus(agentId, await c.conn.request('auth/status', {}));
    } catch {
      /* status is optional */
    }
  }
  const info = authInfo.get(agentId);
  const link = loginLinks.current(agentId);
  const nativeLogout = Boolean(c?.caps?.auth?.logout);
  const hasCliLogout = Boolean(cliLogoutArgsFor(agentId, meta));
  const hasCliSwitch = Boolean(cliSwitchArgsFor(agentId, meta));
  return {
    agentId,
    methods: methods.map(({ keyInMeta: _k, synthetic: _s, terminalCommand: _tc, terminalArgs: _ta, terminalEnv: _te, replaceAgentArgs: _r, flow, ...m }) => ({
      ...m,
      flow: flow as AuthDetailsView['methods'][number]['flow'],
    })),
    savedVars,
    ...(info ? { info } : {}),
    ...(link ? { link } : {}),
    canLogout: nativeLogout || savedVars.length > 0 || hasCliLogout,
    ...(hasCliLogout && !nativeLogout ? { terminalLogout: true } : {}),
    ...(hasCliSwitch ? { terminalSwitch: true } : {}),
    canCheckStatus: Boolean(c?.caps?.auth?.status),
  };
}

/**
 * An API-key or env-var login: keep the values (encrypted), restart the agent with them in its env, then
 * `authenticate` (unless `method.synthetic` is set — those are CLI environment variables applied on process start).
 */
export async function loginWithVars(agentId: string, methodId: string, values: Record<string, string>): Promise<AuthDetailsView> {
  const { deps, host } = need();
  const method = effectiveAuthMethods(agentId, host.rawAuthMethods(agentId), host.agentMeta?.(agentId)).find((m) => m.id === methodId);
  if (!method || (method.flow !== 'api-key' && method.flow !== 'env-vars')) throw new Error('This login method does not take keys or variables.');
  const merged: Record<string, string> = {};
  for (const v of method.vars) merged[v.name] = values[v.name]?.trim() || deps.secrets.getSecret(authVarKey(agentId, v.name)) || '';
  const missing = missingVars(method, merged);
  if (missing.length) throw new Error(`Enter ${missing.join(', ')}.`);
  for (const v of method.vars) if (values[v.name]?.trim()) deps.secrets.setSecret(authVarKey(agentId, v.name), values[v.name].trim());
  await host.restartAgent(agentId);
  const c = await host.connection(agentId, true);
  if (!c) throw new Error('The agent did not start.');
  if (!method.synthetic) {
    try {
      await loginLinks.during(agentId, () => c.conn.request('authenticate', authenticateParams(method, merged)));
    } catch (e: any) {
      // Some env-var ACP agents read the environment on startup and do not implement the `authenticate` RPC (-32601).
      if (e?.code !== -32601) {
        const text = String(e?.message ?? e);
        const clean = Object.values(merged).reduce((t, v) => (v && v.length >= 4 ? t.split(v).join('•••') : t), text);
        throw new Error(clean);
      }
    }
  }
  host.markAuthenticated?.(agentId);
  noteAuthStatus(agentId, { authStatus: { kind: 'api_key', label: 'API key' } });
  return authDetails(agentId);
}

/** Forget a saved login variable (e.g. a key the user wants gone without logging out). */
export function forgetLoginVar(agentId: string, name: string) {
  need().deps.secrets.setSecret(authVarKey(agentId, name), null);
}

/** The login dialog's answer to a link the agent sent during the login. */
export function answerLoginLink(agentId: string, action: 'accept' | 'decline' | 'cancel') {
  loginLinks.answer(agentId, { action });
}
