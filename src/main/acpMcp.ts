import { MCP_PROTOCOL_VERSION, McpOverAcpProvider, McpProtocolError, type McpServerRegistration } from '@agentclientprotocol/sdk/unstable';
import type { McpChatStatus, McpServerState, McpServerStatusView } from '@shared/acpConfig';

/**
 * MCP servers of a chat's ACP session, seen from the app:
 *
 *  1. Status: which servers the session got and what the agent reported about them. Neither adapter reports a
 *     server that started fine, only problems (verified in adapter source, 2026-11-16):
 *       - claude-agent-acp 0.107: a `notice` "MCP server "<name>" failed to start" / "… needs authentication"
 *         (or, without the notices capability, an agent message chunk with `_meta.claudeCode.kind: 'mcpServerStatus'`).
 *       - codex-acp 2.6: a failed `tool_call` titled `mcp__<name>__startup` (id `mcp_startup.<name>.<uuid>`), also
 *         for servers it skipped because its own config has one with that name (`skippedMcpServers` never reaches
 *         the client). That tool call is not a step of the chat: `mcpStartupFromUpdate` turns it into status.
 *     The app's own `olympus` server is confirmed `ready` when the agent calls it (orchestrator.ts → `markReady`).
 *  2. `nextCreateAttempt`: when `session/new` fails, retry without only what the error points at (one server, or
 *     the servers of a transport the agent refused), then without the system prompt, then without connectors,
 *     and only then without any server, so one bad connector no longer silently drops all of them.
 *  3. MCP over ACP (`mcp/message`): for an agent advertising `mcpCapabilities.acp`, the `olympus` tools are served
 *     on the ACP connection itself instead of an HTTP endpoint / stdio bridge. None of claude-agent-acp 0.107,
 *     codex-acp 2.6 (`acp: false`, rejects `type: 'acp'`) or agy 1.5.8 (no `mcpCapabilities`) supports it yet.
 *
 * No Electron imports: the unit tests (tests/acpConfig.unit.mjs) load this file under plain Node.
 */

// ------------------------------------------------------------------ servers → status rows

type Transport = McpServerStatusView['transport'];

/** Transport of one ACP `mcpServers` entry (stdio has no `type`). */
export function transportOf(server: any): Transport {
  const t = server?.type;
  return t === 'http' || t === 'sse' || t === 'acp' ? t : 'stdio';
}

/** Status rows for the servers a session is about to get. `olympusName` is the app's own server's name in it. */
export function describeServers(servers: any[], olympusName: string | undefined, now = Date.now()): McpServerStatusView[] {
  return (servers ?? []).map((s) => ({
    name: String(s?.name ?? ''),
    source: s?.name === olympusName ? 'olympus' : 'connector',
    transport: transportOf(s),
    state: 'sent' as McpServerState,
    at: now,
  }));
}

/** Codex replaces whitespace in server names with `_`; match either form. */
const sameServer = (a: string, b: string) => a === b || a.replace(/\s+/g, '_') === b.replace(/\s+/g, '_');

export interface McpStatusPatch {
  name: string;
  state: McpServerState;
  reason?: string;
}

/** Per-chat status, kept in memory for the live session (a new session starts over). */
export class McpStatusStore {
  private chats = new Map<string, McpChatStatus>();
  private emit: (s: McpChatStatus) => void;
  constructor(emit: (s: McpChatStatus) => void = () => {}) {
    this.emit = emit;
  }

  get(threadId: string): McpChatStatus | undefined {
    return this.chats.get(threadId);
  }

  /** A session was (re)created with these servers; `dropped` were left out on the way, with the reason. */
  begin(threadId: string, agentId: string, rows: McpServerStatusView[], extra: { acpTransport?: boolean } = {}): McpChatStatus {
    const s: McpChatStatus = { threadId, agentId, servers: rows.map((r) => ({ ...r })), ...(extra.acpTransport ? { acpTransport: true } : {}) };
    this.chats.set(threadId, s);
    this.emit(s);
    return s;
  }

  /** Apply what the agent (or the app) reported. Unknown names are added (the agent may name its own servers). */
  apply(threadId: string, patch: McpStatusPatch, now = Date.now()): McpChatStatus | undefined {
    const s = this.chats.get(threadId);
    if (!s) return undefined;
    const row = s.servers.find((r) => sameServer(r.name, patch.name));
    // A later "ready" never hides a reported problem of the same session.
    if (row && patch.state === 'ready' && row.state !== 'sent' && row.state !== 'ready') return s;
    const next: McpServerStatusView = row
      ? { ...row, state: patch.state, at: now, ...(patch.reason ? { reason: patch.reason } : {}) }
      : { name: patch.name, source: 'connector', transport: 'stdio', state: patch.state, at: now, ...(patch.reason ? { reason: patch.reason } : {}) };
    if (!patch.reason && row?.reason && patch.state === 'ready') delete next.reason;
    const servers = row ? s.servers.map((r) => (r === row ? next : r)) : [...s.servers, next];
    const updated = { ...s, servers };
    this.chats.set(threadId, updated);
    this.emit(updated);
    return updated;
  }

  markReady(threadId: string, name: string) {
    const row = this.chats.get(threadId)?.servers.find((r) => sameServer(r.name, name));
    if (row && row.state === 'sent') this.apply(threadId, { name, state: 'ready' });
  }

  /** The app's own server answered the agent (orchestrator.ts): it works in this chat. */
  markOwnReady(threadId: string) {
    const row = this.chats.get(threadId)?.servers.find((r) => r.source === 'olympus');
    if (row && row.state === 'sent') this.apply(threadId, { name: row.name, state: 'ready' });
  }

  forget(threadId: string) {
    this.chats.delete(threadId);
  }
}

// ------------------------------------------------------------------ what the agent reports

const CODEX_STARTUP_TITLE = /^mcp__(.+)__startup$/;
const CODEX_STARTUP_ID = /^mcp_startup\.([^.]+)\./;

function textOfContent(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'content' ? c.content?.text : c?.text) ?? '')
    .filter((t: unknown) => typeof t === 'string' && t)
    .join('\n')
    .trim();
}

/** The agent's message without its wrapper prefix (`[codex-acp forwarded startup error] …`). */
const cleanReason = (text: string) =>
  text
    .replace(/^\[codex-acp[^\]]*\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);

function stateFromText(text: string): McpServerState {
  if (/already defines an MCP server with this name|was not started/i.test(text)) return 'skipped';
  if (/startup was cancelled|cancell?ed/i.test(text)) return 'cancelled';
  if (/needs? (re)?authenticat|oauth|sign[- ]?in|unauthori[sz]ed|401/i.test(text)) return 'needs-auth';
  return 'failed';
}

/**
 * A session update that is an MCP server's startup status, or null.
 * `hide`: the update is only status (Codex's startup tool call) and should not become a step of the chat.
 */
export function mcpStatusFromUpdate(u: any): (McpStatusPatch & { hide: boolean }) | null {
  if (!u || typeof u !== 'object') return null;
  // Codex: a failed tool call `mcp__<name>__startup`.
  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
    const title = typeof u.title === 'string' ? u.title : '';
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : '';
    const byTitle = CODEX_STARTUP_TITLE.exec(title)?.[1];
    const byId = CODEX_STARTUP_ID.exec(id)?.[1];
    const name = byTitle ?? (byId ? safeDecode(byId) : undefined);
    if (!name) return null;
    const text = textOfContent(u.content);
    return { name, state: stateFromText(text), ...(text ? { reason: cleanReason(text) } : {}), hide: true };
  }
  // Claude with the notices capability.
  if (u.sessionUpdate === 'notice') {
    const m = /^MCP server "(.+)" (failed to start|needs authentication)$/.exec(String(u.title ?? ''));
    if (!m) return null;
    const reason = typeof u.description === 'string' && u.description ? u.description : undefined;
    return { name: m[1], state: m[2] === 'failed to start' ? 'failed' : 'needs-auth', ...(reason ? { reason } : {}), hide: false };
  }
  // Claude without it: a quoted message chunk tagged in `_meta`.
  const meta = u._meta?.claudeCode;
  if (u.sessionUpdate === 'agent_message_chunk' && meta?.kind === 'mcpServerStatus' && typeof meta.server === 'string') {
    const st = String(meta.status ?? '');
    const state: McpServerState = st === 'connected' ? 'ready' : st === 'needs-auth' ? 'needs-auth' : st === 'pending' ? 'sent' : 'failed';
    return { name: meta.server, state, hide: false };
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------ session/new retry without one server

export interface CreateAttempt {
  servers: any[];
  systemPrompt: boolean;
}

export interface NextAttempt extends CreateAttempt {
  /** Servers left out by this step, with why (shown in the chat's MCP status). */
  dropped: { name: string; reason: string }[];
  /** One plain sentence for the chat ("Started without the connector X: …"). */
  note: string;
}

const msgOf = (e: any): string => String(e?.message ?? e ?? '').slice(0, 600);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The server the error names: in `data.name` / `data.server`, or quoted / after "server" in the message. */
export function serverNamedIn(err: any, servers: any[]): string | undefined {
  const names = servers.map((s) => String(s?.name ?? '')).filter(Boolean);
  const data = err?.data;
  for (const key of ['name', 'server', 'serverName']) {
    const v = data?.[key];
    if (typeof v === 'string' && names.includes(v)) return v;
  }
  const text = `${msgOf(err)} ${typeof data === 'string' ? data : ''}`;
  // Longest names first, so "github-enterprise" wins over "github".
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const q = escapeRe(n);
    if (new RegExp(`["'\`“‘]${q}["'\`”’]|\\bserver\\s+${q}\\b|\\b${q}\\s+(MCP\\s+)?server\\b`, 'i').test(text)) return n;
  }
  return undefined;
}

/** A transport the error says the agent does not support ("doesn't support MCP SSE transport"). */
export function transportRefusedIn(err: any): Transport | undefined {
  const m = /(?:not|n't)\s+support(?:ed)?\s+(?:the\s+)?(?:MCP\s+)?(sse|http|acp|stdio)\b/i.exec(msgOf(err)) ?? /\b(sse|http|acp|stdio)\s+transport\b[^.]*\bnot\s+supported/i.exec(msgOf(err));
  return m ? (m[1].toLowerCase() as Transport) : undefined;
}

/**
 * The next, smaller `session/new` to try after `err`, or null when nothing is left to leave out.
 * Order: the server the error names → the servers of a refused transport → the system prompt → every
 * connector (the app's own server stays) → every server. Auth errors are the caller's business (never retried here).
 */
export function nextCreateAttempt(err: any, current: CreateAttempt, olympusName: string | undefined): NextAttempt | null {
  const why = msgOf(err) || 'the agent refused the session';
  const named = serverNamedIn(err, current.servers);
  if (named) {
    return {
      servers: current.servers.filter((s) => s?.name !== named),
      systemPrompt: current.systemPrompt,
      dropped: [{ name: named, reason: why }],
      note: `Started without the MCP server "${named}", which the agent refused: ${why}`,
    };
  }
  const transport = transportRefusedIn(err);
  if (transport) {
    const out = current.servers.filter((s) => transportOf(s) === transport);
    if (out.length) {
      return {
        servers: current.servers.filter((s) => transportOf(s) !== transport),
        systemPrompt: current.systemPrompt,
        dropped: out.map((s) => ({ name: String(s.name), reason: `The agent does not support ${transport.toUpperCase()} MCP servers.` })),
        note: `Started without ${out.length === 1 ? `the MCP server "${out[0].name}"` : `${out.length} MCP servers`}: the agent does not support ${transport.toUpperCase()} servers.`,
      };
    }
  }
  if (current.systemPrompt) {
    return { servers: current.servers, systemPrompt: false, dropped: [], note: `Started without the operating guide as a system prompt (${why}); it is sent with the first message instead.` };
  }
  const connectors = current.servers.filter((s) => s?.name !== olympusName);
  if (connectors.length && connectors.length < current.servers.length) {
    return {
      servers: current.servers.filter((s) => s?.name === olympusName),
      systemPrompt: false,
      dropped: connectors.map((s) => ({ name: String(s.name), reason: `Left out after the agent refused the session: ${why}` })),
      note: `Started without your connectors (${connectors.map((s) => s.name).join(', ')}), because the agent refused the session: ${why}`,
    };
  }
  if (current.servers.length) {
    return {
      servers: [],
      systemPrompt: false,
      dropped: current.servers.map((s) => ({ name: String(s.name), reason: `Left out after the agent refused the session: ${why}` })),
      note: `Started without MCP servers, because the agent refused the session with them: ${why}`,
    };
  }
  return null;
}

// ------------------------------------------------------------------ MCP over ACP (`mcp/message`)

export const supportsAcpMcp = (caps: any): boolean => caps?.mcpCapabilities?.acp === true;

/** In-process JSON-RPC handler of the app's MCP server (orchestrator.ts `handleRpc`): a response, or undefined. */
export type OlympusRpc = (threadId: string, msg: { jsonrpc: '2.0'; id: string | number; method: string; params?: any }, closed: () => boolean) => Promise<any | undefined>;

/**
 * Serves the app's `olympus` tools to agents over `mcp/message`. One per app; agents.ts registers
 * `handleRequest` for `methods.client.mcp.message` on every agent connection, and asks `declare` for a chat's
 * `mcpServers` entry when the agent supports the transport.
 */
export class AcpMcpServing {
  readonly provider = new McpOverAcpProvider();
  private regs = new Map<string, McpServerRegistration>();
  private rpc?: OlympusRpc;
  private onCall?: (threadId: string, name: string) => void;

  constructor(opts: { rpc?: OlympusRpc; onCall?: (threadId: string, name: string) => void } = {}) {
    this.rpc = opts.rpc;
    this.onCall = opts.onCall;
  }

  setRpc(rpc: OlympusRpc) {
    this.rpc = rpc;
  }

  /** Register for `onRequest(methods.client.mcp.message, …)`. */
  readonly handleRequest = (ctx: any) => this.provider.handleRequest(ctx);

  /**
   * The `{ type: 'acp', name, serverId }` entry for one chat's session on this connection (`agent` is the
   * connection's agent context, `conn.agent`). Replaces an earlier registration of the same chat.
   */
  async declare(agent: any, threadId: string, name: string): Promise<{ type: 'acp'; name: string; serverId: string }> {
    await this.release(threadId);
    const reg = this.provider.registerServer(agent, { name, handler: (ctx) => this.serve(threadId, name, ctx) });
    this.regs.set(threadId, reg);
    return reg.declaration;
  }

  async release(threadId: string) {
    const reg = this.regs.get(threadId);
    this.regs.delete(threadId);
    await reg?.dispose().catch(() => {});
  }

  private async serve(threadId: string, name: string, ctx: { requestId: string; method: string; params?: Record<string, unknown>; signal: AbortSignal }) {
    if (!this.rpc) throw new McpProtocolError(-32603, 'Olympus tools are not ready yet.');
    this.onCall?.(threadId, name);
    const closed = () => ctx.signal.aborted;
    // MCP 2026-07-28 has no initialize handshake; `server/discover` asks for what initialize used to return.
    const method = ctx.method === 'server/discover' ? 'initialize' : ctx.method;
    const params = ctx.method === 'server/discover' ? { ...(ctx.params ?? {}), protocolVersion: MCP_PROTOCOL_VERSION } : ctx.params;
    const res = await this.rpc(threadId, { jsonrpc: '2.0', id: ctx.requestId, method, ...(params ? { params } : {}) }, closed);
    if (!res) return { result: {} };
    if (res.error) throw new McpProtocolError(Number(res.error.code ?? -32603), String(res.error.message ?? 'MCP error'), res.error.data);
    return { result: res.result ?? null };
  }
}
