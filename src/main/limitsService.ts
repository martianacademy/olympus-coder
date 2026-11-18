// Keeps every ready agent's plan limits fresh without a chat: a read every 5 minutes, right after a window's
// reset time, when the limits UI opens, and before quota checks when the numbers are older than ~2 minutes.
// How one agent is read (local daemon, hidden `/usage`-style session) is the host's business (agents.ts).
// Electron-free so tests/limits.unit.mjs can drive it with fake agents and short timers.

import type { AgentState, AgentStatus, RateLimitView } from '@shared/types';
import { nextResetAt } from '@shared/quota';

/**
 * daemon: a local service the agent runs (Antigravity). probe: a hidden `/usage`-style session (starts the agent).
 * http: the providers the agent is logged in to, read with its saved credentials (OpenCode); never starts it.
 */
export type LimitsReader = 'daemon' | 'probe' | 'http';

export interface LimitsAgentView {
  id: string;
  state: AgentState;
  installed: boolean;
  /** Its process is up (a probe may start it only for a built-in reader; see `mayStart`). */
  running: boolean;
  /** A turn is running in one of its chats: never probe then. */
  busy: boolean;
  limits?: RateLimitView[];
  limitsAt?: number;
}

export interface LimitsReadResult {
  limits: RateLimitView[];
  plan?: string;
  /** The read worked but the agent had no limits to report (API-key login, no data yet). */
  empty?: boolean;
  /** The read showed the agent is logged out. */
  loggedOut?: boolean;
  /** Nothing to read right now (Antigravity's app isn't running): not an error, and not a fresh reading either. */
  unavailable?: boolean;
  /** An honest line for what has no quota, e.g. "LM Studio · local model, no limits" (shown instead of "not reported"). */
  note?: string;
}

export interface LimitsHost {
  agents(): LimitsAgentView[];
  /** How this agent's limits can be read without a chat, or null when they can't. */
  reader(agentId: string): LimitsReader | null;
  /** Whether a read may start the agent's process (only installed agents not known to be logged out). */
  mayStart(agentId: string): boolean;
  /** One read. null = the agent has no way to report limits (don't ask again for a while). */
  read(agentId: string, reader: LimitsReader): Promise<LimitsReadResult | null>;
  /** Merge into the agent's status and emit it. */
  patch(agentId: string, patch: Partial<AgentStatus>): void;
  log?(msg: string): void;
}

export interface LimitsServiceOptions {
  /** Regular cadence. */
  intervalMs?: number;
  /** Older than this counts as stale for quota checks and the limits UI. */
  maxAgeMs?: number;
  /** First retry delay after a failed read; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** After a reset time passes, wait this long before reading (the agent's numbers lag a little). */
  afterResetMs?: number;
  /** Don't ask an agent without a limits command again for this long. */
  unsupportedRetryMs?: number;
  /** The only agents ever read (tests: never the real accounts); undefined = all. */
  only?: string[];
  now?: () => number;
}

interface PerAgent {
  inFlight?: Promise<void>;
  failures: number;
  nextAllowed: number;
  unsupportedUntil: number;
  /** A read was wanted during a live turn: run it when the turn ends. */
  afterTurn?: boolean;
  /** When a reset last triggered a read (rate limit for windows that stay expired). */
  resetReadAt?: number;
}

/** A window still past its reset after a read is read again at most this often. */
const RESET_REREAD_GAP_MS = 60_000;

const ELIGIBLE: AgentState[] = ['ready', 'unknown', 'starting'];

export class LimitsService {
  private host: LimitsHost | undefined;
  private per = new Map<string, PerAgent>();
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private resetTimerAt = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private opts: Required<Omit<LimitsServiceOptions, 'only' | 'now'>> & Pick<LimitsServiceOptions, 'only'>;
  private now: () => number;

  constructor(opts: LimitsServiceOptions = {}) {
    this.opts = {
      intervalMs: opts.intervalMs ?? 5 * 60_000,
      maxAgeMs: opts.maxAgeMs ?? 2 * 60_000,
      backoffMs: opts.backoffMs ?? 2 * 60_000,
      maxBackoffMs: opts.maxBackoffMs ?? 60 * 60_000,
      afterResetMs: opts.afterResetMs ?? 3000,
      unsupportedRetryMs: opts.unsupportedRetryMs ?? 6 * 60 * 60_000,
      only: opts.only,
    };
    this.now = opts.now ?? Date.now;
  }

  setHost(host: LimitsHost) {
    this.host = host;
  }

  /** Background polling: a first read soon after start, then every `intervalMs`. */
  start(firstDelayMs = 4000) {
    this.stop();
    setTimeout(() => void this.refreshAll('start'), firstDelayMs);
    this.tick = setInterval(() => void this.refreshAll('interval'), this.opts.intervalMs);
    this.tick.unref?.();
  }

  stop() {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
    this.resetTimerAt = 0;
  }

  private state(id: string): PerAgent {
    let p = this.per.get(id);
    if (!p) {
      p = { failures: 0, nextAllowed: 0, unsupportedUntil: 0 };
      this.per.set(id, p);
    }
    return p;
  }

  private polled(id: string): boolean {
    return !this.opts.only || this.opts.only.includes(id);
  }

  /** Read every agent that can be read (background cadence; skips agents in backoff or in a live turn). */
  async refreshAll(reason: string): Promise<void> {
    const h = this.host;
    if (!h) return;
    await Promise.all(h.agents().filter((a) => this.polled(a.id)).map((a) => this.refresh(a.id, { reason })));
  }

  /**
   * Read one agent's limits. `force` (the user pressed refresh, or a reset just passed) ignores backoff and
   * the "unsupported" pause; `maxAgeMs` skips the read when the numbers are newer than that.
   */
  refresh(agentId: string, o: { reason: string; force?: boolean; maxAgeMs?: number } = { reason: 'manual' }): Promise<void> {
    const h = this.host;
    if (!h) return Promise.resolve();
    const a = h.agents().find((x) => x.id === agentId);
    if (!a || !a.installed || !this.polled(agentId)) return Promise.resolve();
    const p = this.state(agentId);
    if (p.inFlight) {
      // A reset passed while a read was running: that read may carry the old window. Read again after it unless
      // it brought numbers past the reset.
      if (o.reason !== 'reset') return p.inFlight;
      return p.inFlight.then(() => {
        const now = this.now();
        const cur = h.agents().find((x) => x.id === agentId);
        if ((cur?.limits ?? []).some((l) => l.resetsAt && l.resetsAt <= now)) return this.refresh(agentId, { reason: 'reset (again)', force: true });
      });
    }
    const reader = h.reader(agentId);
    if (!reader) return Promise.resolve();
    const now = this.now();
    if (o.maxAgeMs !== undefined && a.limitsAt && now - a.limitsAt < o.maxAgeMs && !(a.limits ?? []).some((l) => l.resetsAt && l.resetsAt <= now)) return Promise.resolve();
    if (!o.force && (now < p.nextAllowed || now < p.unsupportedUntil)) return Promise.resolve();
    if (reader === 'probe') {
      const busy = ELIGIBLE.includes(a.state) && (a.running || h.mayStart(agentId)) && a.busy;
      const skip = !ELIGIBLE.includes(a.state) ? `state ${a.state}` : !a.running && !h.mayStart(agentId) ? 'not running, may not start it' : busy ? 'a turn is running (read after it)' : '';
      if (skip) {
        if (busy) p.afterTurn = true;
        h.log?.(`[limits] ${agentId} (${o.reason}) skipped: ${skip}`);
        return Promise.resolve();
      }
    }
    p.afterTurn = false;
    h.patch(agentId, { limitsRefreshing: true });
    p.inFlight = (async () => {
      try {
        const r = await h.read(agentId, reader);
        if (r === null) {
          p.unsupportedUntil = this.now() + this.opts.unsupportedRetryMs;
          h.patch(agentId, { limitsRefreshing: false, limitsReadable: false });
          h.log?.(`[limits] ${agentId} (${o.reason}): no limits command`);
          return;
        }
        p.failures = 0;
        p.nextAllowed = 0;
        if (r.unavailable) {
          h.patch(agentId, { limitsRefreshing: false });
          return;
        }
        if (r.loggedOut) {
          h.patch(agentId, { limitsRefreshing: false, limitsError: undefined, state: 'needs-login' });
          h.log?.(`[limits] ${agentId} (${o.reason}): logged out`);
          return;
        }
        h.patch(agentId, {
          limitsRefreshing: false,
          limitsError: undefined,
          limitsReadable: true,
          // A read with nothing to report keeps the numbers a turn brought, but is still a fresh check.
          ...(r.limits.length ? { limits: r.limits } : {}),
          limitsNote: r.note,
          limitsAt: this.now(),
          ...(r.plan ? { plan: r.plan } : {}),
        });
        h.log?.(`[limits] ${agentId} (${o.reason}): ${r.limits.length ? r.limits.map((l) => `${l.window}=${Math.round(l.utilization * 100)}%`).join(' ') : 'nothing to report'}${r.note ? ` · ${r.note}` : ''}`);
      } catch (e: any) {
        p.failures++;
        p.nextAllowed = this.now() + Math.min(this.opts.maxBackoffMs, this.opts.backoffMs * 2 ** (p.failures - 1));
        h.patch(agentId, { limitsRefreshing: false, limitsError: String(e?.message ?? e).slice(0, 200) });
        h.log?.(`[limits] ${agentId} (${o.reason}) failed: ${e?.message ?? e}`);
      } finally {
        p.inFlight = undefined;
        this.scheduleResets();
      }
    })();
    return p.inFlight;
  }

  /** Before a quota decision: read agents whose numbers are older than `maxAgeMs`, waiting at most `timeoutMs`. */
  async ensureFresh(timeoutMs: number, maxAgeMs = this.opts.maxAgeMs): Promise<void> {
    const h = this.host;
    if (!h) return;
    const all = Promise.all(h.agents().filter((a) => this.polled(a.id)).map((a) => this.refresh(a.id, { reason: 'stale', maxAgeMs })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]).finally(() => clearTimeout(timer));
  }

  /** A chat on this agent finished a turn: run a read that was put off, and re-read daemon/provider-backed limits. */
  turnEnded(agentId: string) {
    const p = this.state(agentId);
    const reader = this.host?.reader(agentId);
    if (p.afterTurn) void this.refresh(agentId, { reason: 'after turn' });
    else if (reader === 'daemon' || reader === 'http') void this.refresh(agentId, { reason: 'after turn', force: true });
  }

  /** Limits changed (a read, or numbers a turn brought): plan the next reset wake-up. */
  limitsChanged() {
    this.scheduleResets();
  }

  /**
   * One timer at the nearest due reset across all agents; when it fires, the views flip and the agent is re-read.
   * A window already past its reset that no read has replaced yet (e.g. a read running at the reset brought the
   * old window back) stays due too, at most once a minute per agent, so it can't loop on an agent that lags.
   */
  scheduleResets() {
    const h = this.host;
    if (!h) return;
    const now = this.now();
    let at: number | undefined;
    for (const a of h.agents()) {
      if (!this.polled(a.id)) continue;
      const next = nextResetAt(a.limits, now);
      const candidates = next ? [next + this.opts.afterResetMs] : [];
      if ((a.limits ?? []).some((l) => l.resetsAt && l.resetsAt <= now)) {
        candidates.push(Math.max(now + this.opts.afterResetMs, (this.state(a.id).resetReadAt ?? 0) + RESET_REREAD_GAP_MS));
      }
      for (const t of candidates) if (!at || t < at) at = t;
    }
    if (!at) {
      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
      this.resetTimerAt = 0;
      return;
    }
    if (this.resetTimer && this.resetTimerAt === at) return;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimerAt = at;
    // setTimeout's limit is ~24.8 days; far resets are re-planned on the way.
    this.resetTimer = setTimeout(() => this.onResetTimer(), Math.max(0, Math.min(at - now, 6 * 60 * 60_000)));
    this.resetTimer.unref?.();
  }

  private onResetTimer() {
    this.resetTimer = undefined;
    this.resetTimerAt = 0;
    const h = this.host;
    if (!h) return;
    const now = this.now();
    for (const a of h.agents()) {
      if (!this.polled(a.id) || !(a.limits ?? []).some((l) => l.resetsAt && l.resetsAt <= now)) continue;
      const p = this.state(a.id);
      if (p.resetReadAt && now - p.resetReadAt < RESET_REREAD_GAP_MS - 50) continue;
      p.resetReadAt = now;
      // Re-emit the status as is: every view reads limits through `liveLimits`, so the window now shows as reset.
      h.patch(a.id, {});
      void this.refresh(a.id, { reason: 'reset', force: true });
    }
    this.scheduleResets();
  }
}
