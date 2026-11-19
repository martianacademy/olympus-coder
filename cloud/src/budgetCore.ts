/**
 * Global free-tier daily spend kill-switch and per-upstream circuit breaker (`GlobalBudgetDO`).
 *
 * Guarantees two operational invariants:
 * 1. Free-tier abuse / bot spikes can never exceed the configured daily global USD ceiling (`$10/day` default).
 * 2. Unhealthy or rate-limited upstreams (e.g. a temporary promo provider hitting 429/5xx) trip their circuit
 *    breaker after 3 consecutive failures and auto-failover to official commercial upstreams until cooldown expires.
 */

import { utcDayKey } from './walletCore.js';
import type { StorageKv, UpstreamId } from './types.js';

const STATE_KEY = 'global_budget_v1';
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

interface BreakerEntry {
  consecutiveFailures: number;
  openUntilMs: number;
  lastError?: string;
}

interface StoredBudgetState {
  dayKey: string;
  freeSpendUsdToday: number;
  freeRequestsToday: number;
  breakers: Partial<Record<UpstreamId, BreakerEntry>>;
}

export interface GlobalBudgetStatus {
  dayKey: string;
  freeSpendUsdToday: number;
  freeDailyUsdCap: number;
  freeRequestsToday: number;
  freeKillSwitchTripped: boolean;
  openBreakers: UpstreamId[];
}

export class BudgetCore {
  private readonly kv: StorageKv;

  constructor(kv: StorageKv) {
    this.kv = kv;
  }

  private async load(nowMs: number): Promise<StoredBudgetState> {
    const existing = await this.kv.get<StoredBudgetState>(STATE_KEY);
    const today = utcDayKey(nowMs);
    if (existing) {
      if (existing.dayKey !== today) {
        existing.dayKey = today;
        existing.freeSpendUsdToday = 0;
        existing.freeRequestsToday = 0;
        await this.kv.put(STATE_KEY, existing);
      }
      return existing;
    }
    const fresh: StoredBudgetState = {
      dayKey: today,
      freeSpendUsdToday: 0,
      freeRequestsToday: 0,
      breakers: {},
    };
    await this.kv.put(STATE_KEY, fresh);
    return fresh;
  }

  async checkFreeAllowed(dailyUsdCap: number, nowMs = Date.now()): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
    const st = await this.load(nowMs);
    const cap = Math.max(0, dailyUsdCap);
    return {
      allowed: st.freeSpendUsdToday < cap,
      spentUsd: Number(st.freeSpendUsdToday.toFixed(6)),
      capUsd: cap,
    };
  }

  async recordFreeSpend(usd: number, nowMs = Date.now()): Promise<void> {
    const st = await this.load(nowMs);
    st.freeSpendUsdToday = Number((st.freeSpendUsdToday + Math.max(0, usd)).toFixed(6));
    st.freeRequestsToday += 1;
    await this.kv.put(STATE_KEY, st);
  }

  async isUpstreamHealthy(upstream: UpstreamId, nowMs = Date.now()): Promise<boolean> {
    const st = await this.load(nowMs);
    const b = st.breakers[upstream];
    if (!b) return true;
    return nowMs >= b.openUntilMs;
  }

  async recordUpstreamSuccess(upstream: UpstreamId, nowMs = Date.now()): Promise<void> {
    const st = await this.load(nowMs);
    if (st.breakers[upstream]) {
      delete st.breakers[upstream];
      await this.kv.put(STATE_KEY, st);
    }
  }

  async recordUpstreamFailure(upstream: UpstreamId, reason: string, nowMs = Date.now()): Promise<{ tripped: boolean; openUntilMs: number }> {
    const st = await this.load(nowMs);
    const prev = st.breakers[upstream] ?? { consecutiveFailures: 0, openUntilMs: 0 };
    const nextCount = prev.consecutiveFailures + 1;
    const tripped = nextCount >= BREAKER_FAILURE_THRESHOLD;
    const openUntilMs = tripped ? nowMs + BREAKER_COOLDOWN_MS : prev.openUntilMs;
    st.breakers[upstream] = {
      consecutiveFailures: tripped ? 0 : nextCount,
      openUntilMs,
      lastError: reason.slice(0, 120),
    };
    await this.kv.put(STATE_KEY, st);
    return { tripped, openUntilMs };
  }

  async status(dailyUsdCap: number, nowMs = Date.now()): Promise<GlobalBudgetStatus> {
    const st = await this.load(nowMs);
    const openBreakers = (Object.entries(st.breakers) as [UpstreamId, BreakerEntry][])
      .filter(([, b]) => b && nowMs < b.openUntilMs)
      .map(([id]) => id);
    return {
      dayKey: st.dayKey,
      freeSpendUsdToday: Number(st.freeSpendUsdToday.toFixed(6)),
      freeDailyUsdCap: dailyUsdCap,
      freeRequestsToday: st.freeRequestsToday,
      freeKillSwitchTripped: st.freeSpendUsdToday >= dailyUsdCap,
      openBreakers,
    };
  }
}
