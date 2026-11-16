import type { AgentProvidersView, ProviderInput, ProviderKeyHeader, ProviderSlotView, SavedProviderView } from '@shared/acpConfig';

/**
 * Client-managed model routing (ACP unstable `providers/list|set|disable`, advertised as
 * `agentCapabilities.providers`). Verified in adapter source 2026-11-16:
 *  - claude-agent-acp 0.107: one slot `main`, apiType anthropic / bedrock / vertex (vertex also needs
 *    `_meta.claudeCode.vertex {projectId, region}`); the key travels in `headers` (it sets ANTHROPIC_CUSTOM_HEADERS
 *    and a placeholder `Authorization: Bearer acp-proxy` that a provider `Authorization` header replaces).
 *  - codex-acp 2.6: one slot `openai`, apiType openai only.
 *  - agy 1.5.8: not advertised.
 * Both adapters list the gateway's models on `providers/set` (a wrong URL / key fails the call) and keep the
 * routing in memory only, process-wide: after every agent (re)start the app sends the saved provider again
 * (`reapply`). `providers/disable` returns the agent to its own login.
 *
 * The provider settings and the key are kept in the app's encrypted secret store (Electron safeStorage, injected),
 * the key under its own entry. Keys are never logged, never sent to the renderer, and scrubbed from error text.
 */

export interface ProviderSecrets {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string | null): void;
}

export interface ProviderRequester {
  request(method: string, params: any): Promise<any>;
}

export interface ProviderHost {
  /** The agent's connection and `agentCapabilities`; `start` starts the process when needed. */
  connection(agentId: string, start: boolean): Promise<{ conn: ProviderRequester; caps: any } | null>;
}

export const PROVIDERS_LIST = 'providers/list';
export const PROVIDERS_SET = 'providers/set';
export const PROVIDERS_DISABLE = 'providers/disable';

const configKey = (agentId: string) => `provider:${agentId}`;
const apiKeyKey = (agentId: string) => `provider:${agentId}:key`;

export const providersSupported = (caps: any): boolean => caps?.providers != null && typeof caps.providers === 'object';

/** `providers/list` answer → slots (unknown entries dropped). */
export function parseProviderList(res: any): ProviderSlotView[] {
  const list = Array.isArray(res?.providers) ? res.providers : [];
  return list
    .filter((p: any) => p && typeof p.providerId === 'string' && p.providerId)
    .map((p: any) => ({
      providerId: p.providerId,
      supported: Array.isArray(p.supported) ? p.supported.filter((s: unknown) => typeof s === 'string') : [],
      required: p.required === true,
      ...(p.current && typeof p.current.baseUrl === 'string' ? { current: { apiType: String(p.current.apiType ?? ''), baseUrl: p.current.baseUrl } } : {}),
    }));
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The header that carries the key. */
export function keyHeaders(keyHeader: ProviderKeyHeader, apiKey: string | undefined): Record<string, string> {
  if (!apiKey || keyHeader === 'none') return {};
  if (keyHeader === 'x-api-key') return { 'x-api-key': apiKey };
  if (keyHeader === 'api-key') return { 'api-key': apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

/** The usual key header for an API type: OpenAI-style gateways take a bearer token, Azure an `api-key`. */
export function defaultKeyHeader(apiType: string): ProviderKeyHeader {
  if (apiType === 'azure') return 'api-key';
  if (apiType === 'vertex') return 'none';
  return 'authorization';
}

/** Checks the input against the slot. Returns an error sentence, or undefined when it can be sent. */
export function validateProvider(input: ProviderInput, slot: ProviderSlotView | undefined): string | undefined {
  if (!slot) return `This agent has no model provider "${input.providerId}".`;
  if (!input.apiType || (slot.supported.length && !slot.supported.includes(input.apiType))) return `Choose an API type: ${slot.supported.join(', ')}.`;
  if (!isHttpUrl(input.baseUrl.trim())) return 'Enter a base URL starting with https:// (or http:// for a local gateway).';
  if (input.apiType === 'vertex' && (!input.vertex?.projectId?.trim() || !input.vertex?.region?.trim())) return 'Vertex needs a Google Cloud project ID and region.';
  return undefined;
}

/** `providers/set` params. */
export function setParams(saved: Omit<SavedProviderView, 'hasKey'>, apiKey: string | undefined): any {
  const p: any = { providerId: saved.providerId, apiType: saved.apiType, baseUrl: saved.baseUrl, headers: keyHeaders(saved.keyHeader, apiKey) };
  if (saved.apiType === 'vertex' && saved.vertex) p._meta = { claudeCode: { vertex: { projectId: saved.vertex.projectId, region: saved.vertex.region } } };
  return p;
}

/** Error text for the user, with the key (and anything after `Bearer`) removed. */
export function scrubKey(text: string, apiKey: string | undefined): string {
  let t = text;
  if (apiKey && apiKey.length >= 4) t = t.split(apiKey).join('•••');
  return t.replace(/(Bearer\s+)[^\s"',}]+/gi, '$1•••').replace(/((?:x-)?api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1•••');
}

type StoredConfig = Omit<SavedProviderView, 'hasKey'>;

export class ProviderService {
  private secrets: ProviderSecrets;
  private host: ProviderHost;
  constructor(secrets: ProviderSecrets, host: ProviderHost) {
    this.secrets = secrets;
    this.host = host;
  }

  saved(agentId: string): SavedProviderView | undefined {
    const raw = this.secrets.getSecret(configKey(agentId));
    if (!raw) return undefined;
    try {
      const c = JSON.parse(raw) as StoredConfig;
      if (!c || typeof c.providerId !== 'string' || typeof c.baseUrl !== 'string') return undefined;
      return { ...c, hasKey: Boolean(this.secrets.getSecret(apiKeyKey(agentId))) };
    } catch {
      return undefined;
    }
  }

  private store(agentId: string, c: StoredConfig | null) {
    this.secrets.setSecret(configKey(agentId), c ? JSON.stringify(c) : null);
  }

  /** Settings → Agents: the agent's slots (starts the agent when `start`) and what the user saved. */
  async view(agentId: string, start = true): Promise<AgentProvidersView> {
    const saved = this.saved(agentId);
    const c = await this.host.connection(agentId, start).catch(() => null);
    if (!c) return { agentId, known: false, supported: false, slots: [], ...(saved ? { saved } : {}) };
    if (!providersSupported(c.caps)) return { agentId, known: true, supported: false, slots: [], ...(saved ? { saved } : {}) };
    try {
      const slots = parseProviderList(await c.conn.request(PROVIDERS_LIST, {}));
      return { agentId, known: true, supported: true, slots, ...(saved ? { saved } : {}) };
    } catch (e: any) {
      return { agentId, known: true, supported: true, slots: [], ...(saved ? { saved } : {}), error: scrubKey(String(e?.message ?? e), undefined) };
    }
  }

  /** Validate, send `providers/set`, and keep it (only after the agent accepted it). */
  async set(agentId: string, input: ProviderInput): Promise<AgentProvidersView> {
    const c = await this.host.connection(agentId, true);
    if (!c || !providersSupported(c.caps)) throw new Error('This agent does not support a custom model provider.');
    const slots = parseProviderList(await c.conn.request(PROVIDERS_LIST, {}));
    const problem = validateProvider(input, slots.find((s) => s.providerId === input.providerId));
    if (problem) throw new Error(problem);
    const newKey = input.apiKey?.trim() || undefined;
    const apiKey = newKey ?? this.secrets.getSecret(apiKeyKey(agentId));
    const config: StoredConfig = {
      providerId: input.providerId,
      apiType: input.apiType,
      baseUrl: input.baseUrl.trim(),
      keyHeader: input.keyHeader,
      ...(input.apiType === 'vertex' && input.vertex ? { vertex: { projectId: input.vertex.projectId.trim(), region: input.vertex.region.trim() } } : {}),
    };
    try {
      await c.conn.request(PROVIDERS_SET, setParams(config, apiKey));
    } catch (e: any) {
      throw new Error(`The agent did not accept this provider: ${scrubKey(String(e?.message ?? e), apiKey)}`);
    }
    if (newKey) this.secrets.setSecret(apiKeyKey(agentId), newKey);
    this.store(agentId, { ...config, appliedAt: Date.now() });
    return this.view(agentId, false);
  }

  /** Back to the agent's own login: `providers/disable` and forget the saved provider and key. */
  async disable(agentId: string, providerId?: string): Promise<AgentProvidersView> {
    const saved = this.saved(agentId);
    const id = providerId ?? saved?.providerId;
    const c = await this.host.connection(agentId, false).catch(() => null);
    if (c && id && providersSupported(c.caps)) await c.conn.request(PROVIDERS_DISABLE, { providerId: id });
    this.store(agentId, null);
    this.secrets.setSecret(apiKeyKey(agentId), null);
    return this.view(agentId, false);
  }

  /**
   * After the agent process (re)started: send the saved provider again (adapters keep it in memory only).
   * Returns an error sentence when the agent refused it (also kept on the saved provider), else undefined.
   */
  async reapply(agentId: string, conn: ProviderRequester, caps: any): Promise<string | undefined> {
    const saved = this.saved(agentId);
    if (!saved || !providersSupported(caps)) return undefined;
    const apiKey = this.secrets.getSecret(apiKeyKey(agentId));
    const { hasKey: _hasKey, error: _error, ...config } = saved;
    try {
      await conn.request(PROVIDERS_SET, setParams(config, apiKey));
      this.store(agentId, { ...config, appliedAt: Date.now() });
      return undefined;
    } catch (e: any) {
      const error = scrubKey(String(e?.message ?? e), apiKey);
      this.store(agentId, { ...config, error });
      return error;
    }
  }
}
