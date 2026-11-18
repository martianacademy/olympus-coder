// Plan limits read through an agent's own local command, in a hidden ACP session that never becomes a chat.
//
// - Claude Code (`claude-agent-acp`): a prompt that is exactly `/usage` runs Claude Code's local `usage` command
//   (`type: "local"`, no model call); the adapter replaces its text with `formatUsageResponse()` markdown:
//   `**5-hour limit** — **37%** · Resets Nov 16, 3:30 PM GMT+5:30`.
// - Codex (`codex-acp`): `/status` is handled by the adapter itself (`account/rateLimits/read`, no turn):
//   `**5h limit:** 63% left (resets 14:30)` / `**Weekly limit:** 90% left (resets 09:00 on 20 Nov)`.
// Electron-free so tests/limits.unit.mjs can run it on plain Node.

import type { RateLimitView } from '@shared/types';

export type ProbeCommand = 'usage' | 'status';

/** Local commands that print plan limits without a model call, in order of preference. */
export const PROBE_COMMANDS: ProbeCommand[] = ['usage', 'status'];

/**
 * Which agent this is, for how its limits are read: by id for built-ins, else by the binary it runs (a custom
 * `olympus-cli` entry still runs `oly`; `opencode-v2` from the registry still runs `opencode`).
 */
export type LimitsKind = 'claude' | 'codex' | 'antigravity' | 'olympus' | 'opencode';

export function limitsKindOf(def: { id: string; command?: string; args?: string[]; registryId?: string }): LimitsKind | undefined {
  if (def.id === 'claude' || def.id === 'codex' || def.id === 'antigravity' || def.id === 'olympus') return def.id;
  const bin = (def.command ?? '').split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, '').toLowerCase() ?? '';
  const script = (def.args ?? []).map((a) => a.split(/[\\/]/).pop()?.toLowerCase() ?? '');
  if (bin === 'opencode' || /^opencode(-v2)?$/.test(def.registryId ?? '') || /^opencode(-v2)?$/.test(def.id)) return 'opencode';
  if (bin === 'oly' || def.id === 'olympus-cli' || script.includes('olympus.js')) return 'olympus';
  return undefined;
}

/** Agents whose limits command is known before any session (`claude-agent-acp`, `codex-acp`, Olympus CLI). */
const BUILTIN_COMMAND: Partial<Record<LimitsKind, ProbeCommand>> = { claude: 'usage', codex: 'status', olympus: 'status' };

/**
 * The limits command for an agent: from the commands it advertised, else the known one for its kind.
 * Olympus CLI: `/usage` once it implements the limits contract, else its local `/status`.
 */
export function probeCommandFor(agentId: string, advertised?: string[], kind: LimitsKind | undefined = limitsKindOf({ id: agentId })): ProbeCommand | undefined {
  if (advertised?.length) {
    const names = new Set(advertised.map((n) => n.replace(/^\//, '')));
    const hit = PROBE_COMMANDS.find((c) => names.has(c));
    if (hit) return hit;
  }
  return kind ? BUILTIN_COMMAND[kind] : undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIndex = (m: string) => MONTHS.indexOf(m.slice(0, 3).toLowerCase());

/** Minutes east of UTC from a short zone name (`GMT+5:30`, `UTC`, `GMT-7`), or undefined when it isn't one. */
function zoneOffset(zone: string | undefined): number | undefined {
  if (!zone) return undefined;
  const z = zone.trim();
  if (/^(GMT|UTC|Z)$/i.test(z)) return 0;
  const m = /^(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(z);
  if (!m) return undefined;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * A wall-clock time to epoch ms. Without a parseable zone the time is local: the adapter runs on this machine,
 * in this time zone. Without a year, the one that puts the date nearest after `now` (resets lie ahead).
 */
function wallClock(now: number, parts: { month?: number; day?: number; hour: number; minute: number; zone?: string }): number {
  const offset = zoneOffset(parts.zone);
  const ref = new Date(now);
  const build = (year: number, month: number, day: number) =>
    offset === undefined ? new Date(year, month, day, parts.hour, parts.minute).getTime() : Date.UTC(year, month, day, parts.hour, parts.minute) - offset * 60_000;
  if (parts.month === undefined || parts.day === undefined) {
    // Time only: today (Codex prints the date only when the reset is not today).
    return build(ref.getFullYear(), ref.getMonth(), ref.getDate());
  }
  // The first of last / this / next year that is not well in the past (local and UTC years can differ near New Year).
  const y = ref.getFullYear();
  const month = parts.month;
  const day = parts.day;
  return [y - 1, y, y + 1].map((year) => build(year, month, day)).find((at) => at >= now - 2 * 86_400_000) ?? build(y + 1, month, day);
}

const SPACE = '[\\s\\u00a0\\u202f]';

/** `Nov 16, 3:30 PM GMT+5:30` (Intl `en`, month short) → epoch ms. */
export function parseClaudeReset(text: string, now = Date.now()): number | undefined {
  const re = new RegExp(`([A-Za-z]{3,})${SPACE}+(\\d{1,2}),?${SPACE}+(?:at${SPACE}+)?(\\d{1,2}):(\\d{2})${SPACE}*([AaPp][Mm])?(?:${SPACE}+([A-Za-z]{2,5}(?:[+-]\\d{1,2}(?::?\\d{2})?)?))?`);
  const m = re.exec(text);
  if (!m) return undefined;
  const month = monthIndex(m[1]);
  if (month < 0) return undefined;
  let hour = Number(m[3]) % 24;
  const ampm = m[5]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return wallClock(now, { month, day: Number(m[2]), hour, minute: Number(m[4]), zone: m[6] });
}

/** Codex: `14:30`, `14:30 on 20 Nov`, `14:30 on Nov 20`, or a bare `Nov 20` (spend limit) → epoch ms. */
export function parseCodexReset(text: string, now = Date.now()): number | undefined {
  const t = text.trim();
  const time = /(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?/.exec(t);
  const dm = /(\d{1,2})\s+([A-Za-z]{3,})/.exec(t);
  const md = /([A-Za-z]{3,})\s+(\d{1,2})\b/.exec(t);
  let month: number | undefined;
  let day: number | undefined;
  if (dm && monthIndex(dm[2]) >= 0) [month, day] = [monthIndex(dm[2]), Number(dm[1])];
  else if (md && monthIndex(md[1]) >= 0) [month, day] = [monthIndex(md[1]), Number(md[2])];
  if (!time && month === undefined) return undefined;
  let hour = time ? Number(time[1]) % 24 : 0;
  const ampm = time?.[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return wallClock(now, { month, day, hour, minute: time ? Number(time[2]) : 0 });
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1').trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Claude labels → the window ids and labels `_claude/rateLimit` uses in turns, so both sources line up. */
function claudeWindow(label: string): { window: string; label: string } {
  const l = label.toLowerCase();
  if (/^5-hour/.test(l) || l.includes('session')) return { window: 'five_hour', label: '5-hour limit' };
  const scoped = /^weekly\s*[·:-]?\s*(.+)$/i.exec(label);
  if (scoped) {
    const what = scoped[1].trim();
    if (/^all models$/i.test(what)) return { window: 'seven_day', label: 'Weekly limit' };
    if (/^opus$/i.test(what)) return { window: 'seven_day_opus', label: 'Weekly (Opus)' };
    if (/^sonnet$/i.test(what)) return { window: 'seven_day_sonnet', label: 'Weekly (Sonnet)' };
    return { window: `seven_day_${slug(what)}`, label: `Weekly (${what})` };
  }
  if (/week/.test(l)) {
    if (/opus/.test(l)) return { window: 'seven_day_opus', label: 'Weekly (Opus)' };
    if (/sonnet/.test(l)) return { window: 'seven_day_sonnet', label: 'Weekly (Sonnet)' };
    return { window: 'seven_day', label: 'Weekly limit' };
  }
  return { window: slug(label) || 'limit', label };
}

/**
 * Claude's `/usage` reply → limit windows. Reads the adapter's structured markdown
 * (`**<label>** — **<pct>%** · Resets <date>`); when the adapter fell back to Claude Code's own text,
 * reads any `<label>: <n>% used` lines instead. Plan from `> Claude <plan> subscription usage`.
 */
export function parseClaudeUsage(text: string, now = Date.now()): { limits: RateLimitView[]; plan?: string } {
  const limits: RateLimitView[] = [];
  const plan = /^>\s*Claude\s+(.+?)\s+subscription usage/im.exec(text)?.[1];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\*(.+?)\*\*\s*[—–-]\s*\*\*(\d+(?:\.\d+)?)%\*\*(.*)$/.exec(line.trim());
    if (!m) continue;
    const { window, label } = claudeWindow(unescape(m[1]));
    const reset = /Resets\s+(.+)$/i.exec(m[3])?.[1];
    limits.push({ window, label, utilization: Math.max(0, Math.min(1, Number(m[2]) / 100)), resetsAt: reset ? parseClaudeReset(reset, now) : undefined });
  }
  if (!limits.length) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^[\s*#>-]*([A-Za-z][\w ()·-]{1,40}?)\s*:?\s*\**\s*(\d+(?:\.\d+)?)%\s*used/i.exec(line);
      if (!m) continue;
      const { window, label } = claudeWindow(unescape(m[1]));
      const reset = /resets?\s+(.+)$/i.exec(line)?.[1];
      limits.push({ window, label, utilization: Math.max(0, Math.min(1, Number(m[2]) / 100)), resetsAt: reset ? parseClaudeReset(reset, now) : undefined });
    }
  }
  // `> Claude max subscription usage` → "Claude Max" (the same wording as the account's plan label).
  const name = plan ? unescape(plan) : '';
  return { limits: dedupe(limits), ...(name ? { plan: `Claude ${name[0].toUpperCase()}${name.slice(1)}` } : {}) };
}

/** Codex window labels (`5h limit`, `7d limit`, `Weekly limit`) → readable labels and stable ids. */
function codexWindow(label: string): { window: string; label: string } {
  const l = label.trim();
  const hours = /^(\d+)h limit$/i.exec(l);
  if (hours) return { window: `codex_${hours[1]}h`, label: `${hours[1]}-hour limit` };
  const days = /^(\d+)d limit$/i.exec(l);
  if (days) return Number(days[1]) >= 7 ? { window: 'codex_weekly', label: 'Weekly limit' } : { window: `codex_${days[1]}d`, label: `${days[1]}-day limit` };
  if (/^weekly limit$/i.test(l)) return { window: 'codex_weekly', label: 'Weekly limit' };
  if (/individual spend limit/i.test(l)) return { window: 'codex_spend', label: 'Spend limit' };
  return { window: `codex_${slug(l)}`, label: l };
}

/**
 * Codex's `/status` reply → limit windows. Lines are `**[<limit name> ]<window>:** <n>% left[ (resets …)]`.
 * Only the account's main limit (`codex`, or unnamed) is kept: other named limits apply to single models and
 * would mark the whole agent as used up. `plan` from `**Account:** ChatGPT <plan> (<email>)`; `loggedOut` when
 * the account line says so.
 */
export function parseCodexStatus(text: string, now = Date.now()): { limits: RateLimitView[]; plan?: string; loggedOut?: boolean; noData?: boolean } {
  const limits: RateLimitView[] = [];
  let plan: string | undefined;
  let loggedOut = false;
  let noData = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const acct = /^\*\*Account:\*\*\s*(.+)$/.exec(line);
    if (acct) {
      if (/not logged in/i.test(acct[1])) loggedOut = true;
      const p = /^ChatGPT\s+(\S+)/i.exec(acct[1]);
      if (p) plan = `ChatGPT ${p[1][0].toUpperCase()}${p[1].slice(1)}`;
      continue;
    }
    if (/^\*\*Limits:\*\*\s*data not available/i.test(line)) noData = true;
    const m = /^\*\*(.+?):\*\*\s*(\d+(?:\.\d+)?)% left(.*)$/.exec(line);
    if (!m) continue;
    let name = m[1].trim();
    const scope = /^(.*?)\s*\b(\d+[hdm] limit|Weekly limit|Limit|individual spend limit)$/i.exec(name);
    const prefix = scope ? scope[1].trim() : '';
    if (prefix && prefix.toLowerCase() !== 'codex') continue;
    if (scope) name = scope[2];
    const { window, label } = codexWindow(name);
    const reset = /resets\s+([^);]+)\)?/i.exec(m[3])?.[1];
    limits.push({ window, label, utilization: Math.max(0, Math.min(1, (100 - Number(m[2])) / 100)), resetsAt: reset ? parseCodexReset(reset, now) : undefined });
  }
  return { limits: dedupe(limits), ...(plan ? { plan } : {}), ...(loggedOut ? { loggedOut } : {}), ...(noData && !limits.length ? { noData } : {}) };
}

/** `$1.39 of $10` / `37 of 300 requests` inside a limit line. */
function amountIn(text: string): RateLimitView['amount'] | undefined {
  const usd = /\$\s*([\d,]+(?:\.\d+)?)\s+of\s+\$\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (usd) return { used: Number(usd[1].replace(/,/g, '')), limit: Number(usd[2].replace(/,/g, '')), unit: 'usd' };
  const req = /([\d,]+)\s+of\s+([\d,]+)\s+requests/i.exec(text);
  if (req) return { used: Number(req[1].replace(/,/g, '')), limit: Number(req[2].replace(/,/g, '')), unit: 'requests' };
  return undefined;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;

/**
 * Olympus CLI's `/status` (today) or `/usage` (the limits contract) → limits and an honest note.
 * - Limit lines use Claude's `/usage` shape: `**<label>** — **<pct>%** · Resets <date>[ · $<used> of $<limit>]`.
 * - `**Limits:** <text>` is the CLI's own word when there are none (e.g. `none (local model)`).
 * - Without either, the gateway line decides: a local server has no limits; a remote API key has no quota the CLI
 *   reports yet. `plan` is the gateway's name, e.g. "LM Studio (local)".
 */
export function parseOlympusStatus(text: string, now = Date.now()): { limits: RateLimitView[]; plan?: string; note?: string } {
  const limits: RateLimitView[] = [];
  let plan: string | undefined;
  let note: string | undefined;
  let local = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const gw = /^[-*]?\s*\*\*Gateway\*\*:\s*(.+?)\s*\(`([^`]+)`\)/.exec(line);
    if (gw) {
      plan = unescape(gw[1]);
      try {
        local = LOCAL_HOST.test(new URL(gw[2]).hostname);
      } catch {
        local = /\blocal\b/i.test(plan);
      }
      continue;
    }
    const lim = /^[-*]?\s*\*\*Limits:?\*\*:?\s*(.+)$/.exec(line);
    if (lim) {
      note = unescape(lim[1]).slice(0, 160);
      continue;
    }
    const m = /^\*\*(.+?)\*\*\s*[—–-]\s*\*\*(\d+(?:\.\d+)?)%\*\*(.*)$/.exec(line);
    if (!m) continue;
    const { window, label } = claudeWindow(unescape(m[1]));
    const reset = /Resets\s+(.+?)(?:\s+·\s+|$)/i.exec(m[3])?.[1];
    const amount = amountIn(m[3]);
    limits.push({ window, label, utilization: Math.max(0, Math.min(1, Number(m[2]) / 100)), resetsAt: reset ? parseClaudeReset(reset, now) : undefined, ...(amount ? { amount } : {}) });
  }
  if (!limits.length && !note && plan) {
    const name = plan.replace(/\s*\(local\)\s*$/i, '');
    note = local ? `${name} · local model, no limits` : `${name} · API key, pay per use · no quota reported`;
  }
  return { limits: dedupe(limits), ...(plan ? { plan } : {}), ...(note ? { note } : {}) };
}

function dedupe(limits: RateLimitView[]): RateLimitView[] {
  const seen = new Map<string, RateLimitView>();
  for (const l of limits) if (!seen.has(l.window)) seen.set(l.window, l);
  return [...seen.values()];
}

export interface ProbeResult {
  limits: RateLimitView[];
  plan?: string;
  loggedOut?: boolean;
  /** The command ran but reported no limits (e.g. Codex "data not available yet", an API-key login). */
  empty?: boolean;
  /** Why there is nothing to show, in the agent's terms (Olympus CLI: "LM Studio · local model, no limits"). */
  note?: string;
  command: ProbeCommand;
}

/** Parse a limits command's reply (`kind` picks the agent's own format; Olympus CLI has one for both commands). */
export function parseProbeReply(command: ProbeCommand, text: string, now = Date.now(), kind?: LimitsKind): ProbeResult {
  if (kind === 'olympus') {
    const r = parseOlympusStatus(text, now);
    return { ...r, command, ...(r.limits.length ? {} : { empty: true }) };
  }
  if (command === 'usage') {
    const r = parseClaudeUsage(text, now);
    return { ...r, command, ...(r.limits.length ? {} : { empty: true }) };
  }
  const r = parseCodexStatus(text, now);
  return { limits: r.limits, command, ...(r.plan ? { plan: r.plan } : {}), ...(r.loggedOut ? { loggedOut: true } : {}), ...(r.limits.length ? {} : { empty: true }) };
}

// ------------------------------------------------------------------ hidden probe sessions

interface Collector {
  text: string[];
  commands?: string[];
  onCommands?: () => void;
}

/**
 * Sessions opened only to read limits. `routeUpdate` offers every update here first; a probe session's updates
 * are collected and swallowed, so they never reach a chat, the Tasks panel or the agent-initiated turn logic.
 */
export class ProbeSessions {
  private live = new Map<string, Collector>();

  open(sessionId: string): Collector {
    const c: Collector = { text: [] };
    this.live.set(sessionId, c);
    return c;
  }

  close(sessionId: string) {
    this.live.delete(sessionId);
  }

  has(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && this.live.has(sessionId);
  }

  /** True when the update belonged to a probe session (and was consumed). */
  offer(sessionId: unknown, update: any): boolean {
    const c = typeof sessionId === 'string' ? this.live.get(sessionId) : undefined;
    if (!c) return false;
    const kind = update?.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      const blocks = Array.isArray(update.content) ? update.content : [update.content];
      for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') c.text.push(b.text);
    } else if (kind === 'available_commands_update') {
      c.commands = (update.availableCommands ?? []).map((x: any) => String(x?.name ?? ''));
      c.onCommands?.();
    }
    return true;
  }
}

export interface ProbeRpc {
  request(method: string, params: any): Promise<any>;
}

export interface ProbeOptions {
  agentId: string;
  cwd: string;
  /** Already known (built-in agent, or advertised before); otherwise read from the session's command list. */
  command?: ProbeCommand;
  /** The agent supports `session/close`. */
  canClose: boolean;
  /** Delete the probe session afterwards (`session/delete`): agents that keep every session on disk (Olympus CLI). */
  deleteAfter?: boolean;
  /** Which agent's reply format to parse (see `parseProbeReply`). */
  kind?: LimitsKind;
  /** `_meta` for `session/new` (Claude: don't keep a transcript, don't start the user's MCP servers). */
  meta?: Record<string, unknown>;
  timeoutMs: number;
  /** How long to wait for the command list when the command isn't known yet. */
  waitCommandsMs?: number;
  now?: () => number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Open a hidden session, run the agent's limits command, read the reply, close the session.
 * Returns null when the agent has no limits command. Throws on protocol errors (the caller backs off).
 */
export async function runProbe(rpc: ProbeRpc, sessions: ProbeSessions, opts: ProbeOptions): Promise<ProbeResult | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => Math.max(1000, deadline - Date.now());
  const res = await withTimeout(rpc.request('session/new', { cwd: opts.cwd, mcpServers: [], ...(opts.meta ? { _meta: opts.meta } : {}) }), left(), 'Opening the limits session');
  const sessionId: string | undefined = res?.sessionId;
  if (!sessionId) throw new Error('The agent returned no session id.');
  const c = sessions.open(sessionId);
  try {
    let command = opts.command;
    if (!command) {
      if (!c.commands) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(opts.waitCommandsMs ?? 2500, left()));
          c.onCommands = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
      command = probeCommandFor(opts.agentId, c.commands, opts.kind);
      if (!command) return null;
    }
    const reply = await withTimeout(rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `/${command}` }] }), left(), `/${command}`);
    if (reply?.stopReason && reply.stopReason !== 'end_turn') throw new Error(`/${command} ended with "${reply.stopReason}".`);
    return parseProbeReply(command, c.text.join(''), opts.now?.() ?? Date.now(), opts.kind);
  } finally {
    sessions.close(sessionId);
    if (opts.deleteAfter) await withTimeout(rpc.request('session/delete', { sessionId }), 5000, 'Deleting the limits session').catch(() => {});
    else if (opts.canClose) await withTimeout(rpc.request('session/close', { sessionId }), 5000, 'Closing the limits session').catch(() => {});
  }
}
