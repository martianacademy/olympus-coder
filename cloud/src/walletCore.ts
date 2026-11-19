/**
 * Atomic per-user wallet state machine designed to run inside a single-threaded Cloudflare Durable Object
 * (`UserWalletDO`), guaranteeing zero overdraft races even when 6+ parallel sub-sessions stream at once.
 *
 * Credit consumption order: `starterGiftCredits` -> `monthlyCredits` -> `topupCredits`.
 * Monthly subscription credits reset on renewal (no rollover); top-up credits never expire.
 */

import { PLANS, STARTER_GIFT_CREDITS } from './pricing.js';
import type {
  PendingReservation,
  PlanTier,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  StorageKv,
  WalletSnapshot,
} from './types.js';

const STATE_KEY = 'wallet_v1';
const RESERVATION_TTL_MS = 5 * 60_000;
const MAX_PROCESSED_EVENTS = 200;

interface StoredWalletState {
  userId: string;
  plan: PlanTier;
  monthlyCredits: number;
  topupCredits: number;
  starterGiftCredits: number;
  starterGiftClaimed: boolean;
  monthlyResetAt: number;
  freeDayKey: string;
  freeRequestsUsedToday: number;
  pending: Record<string, PendingReservation>;
  processedEventIds: string[];
}

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function round4(n: number): number {
  return Number(Math.max(0, n).toFixed(4));
}

export class WalletCore {
  private readonly kv: StorageKv;
  private readonly userId: string;

  constructor(kv: StorageKv, userId: string) {
    this.kv = kv;
    this.userId = userId;
  }

  private async load(nowMs: number): Promise<StoredWalletState> {
    const existing = await this.kv.get<StoredWalletState>(STATE_KEY);
    if (existing) {
      let dirty = false;
      const today = utcDayKey(nowMs);
      if (existing.freeDayKey !== today) {
        existing.freeDayKey = today;
        existing.freeRequestsUsedToday = 0;
        dirty = true;
      }
      // Expire stale in-flight reservations from crashed workers/streams so credits never stay locked.
      for (const [id, res] of Object.entries(existing.pending)) {
        if (nowMs - res.createdAt > RESERVATION_TTL_MS) {
          delete existing.pending[id];
          dirty = true;
        }
      }
      if (dirty) await this.kv.put(STATE_KEY, existing);
      return existing;
    }

    const fresh: StoredWalletState = {
      userId: this.userId,
      plan: 'free',
      monthlyCredits: 0,
      topupCredits: 0,
      starterGiftCredits: 0,
      starterGiftClaimed: false,
      monthlyResetAt: 0,
      freeDayKey: utcDayKey(nowMs),
      freeRequestsUsedToday: 0,
      pending: {},
      processedEventIds: [],
    };
    await this.kv.put(STATE_KEY, fresh);
    return fresh;
  }

  private toSnapshot(st: StoredWalletState): WalletSnapshot {
    const reservedCredits = round4(
      Object.values(st.pending).reduce((sum, r) => sum + r.reservedCredits, 0),
    );
    const totalOwned = st.starterGiftCredits + st.monthlyCredits + st.topupCredits;
    const availableCredits = round4(Math.max(0, totalOwned - reservedCredits));
    return {
      userId: st.userId,
      plan: st.plan,
      monthlyCredits: round4(st.monthlyCredits),
      topupCredits: round4(st.topupCredits),
      starterGiftCredits: round4(st.starterGiftCredits),
      reservedCredits,
      availableCredits,
      monthlyResetAt: st.monthlyResetAt,
      freeDayKey: st.freeDayKey,
      freeRequestsUsedToday: st.freeRequestsUsedToday,
      freeDailyLimit: PLANS[st.plan].freeDailyReqLimit,
    };
  }

  async snapshot(nowMs = Date.now()): Promise<WalletSnapshot> {
    return this.toSnapshot(await this.load(nowMs));
  }

  /** Disabled in paid-only mode (`STARTER_GIFT_CREDITS === 0`); kept as a safe no-op for existing DO RPC callers. */
  async grantStarterGift(nowMs = Date.now()): Promise<{ granted: boolean; wallet: WalletSnapshot }> {
    const st = await this.load(nowMs);
    if (STARTER_GIFT_CREDITS <= 0 || st.starterGiftClaimed) {
      return { granted: false, wallet: this.toSnapshot(st) };
    }
    st.starterGiftClaimed = true;
    st.starterGiftCredits = round4(st.starterGiftCredits + STARTER_GIFT_CREDITS);
    await this.kv.put(STATE_KEY, st);
    return { granted: true, wallet: this.toSnapshot(st) };
  }

  /**
   * Atomically reserve minimum paid credits before opening an upstream stream.
   * Free-lane requests are rejected immediately when `freeDailyLimit <= 0` (paid-only mode).
   */
  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const st = await this.load(req.nowMs);
    const effectiveFreeLimit = Math.max(0, req.freeDailyLimit ?? PLANS[st.plan].freeDailyReqLimit);

    if (req.lane === 'free') {
      if (effectiveFreeLimit <= 0) {
        return {
          ok: false,
          code: 'FREE_DAILY_LIMIT',
          message:
            'Olympus Cloud is paid-credits only. Subscribe at https://olympus-cloud.olympus-relay.workers.dev/cloud or use your own OpenRouter / Anthropic / OpenAI key or Local Ollama in oly.',
          wallet: this.toSnapshot(st),
        };
      }
      const pendingFreeCount = Object.values(st.pending).filter((p) => p.lane === 'free').length;
      if (st.freeRequestsUsedToday + pendingFreeCount >= effectiveFreeLimit) {
        return {
          ok: false,
          code: 'FREE_DAILY_LIMIT',
          message: `Daily free limit reached (${effectiveFreeLimit} requests/day). Upgrade to Olympus Starter ($20/mo) or switch to your own API key.`,
          wallet: this.toSnapshot(st),
        };
      }
      st.pending[req.reservationId] = {
        id: req.reservationId,
        lane: 'free',
        reservedCredits: 0,
        createdAt: req.nowMs,
      };
      await this.kv.put(STATE_KEY, st);
      return { ok: true, wallet: this.toSnapshot(st) };
    }

    const snap = this.toSnapshot(st);
    const needed = Math.max(0.01, req.minCredits);
    if (snap.availableCredits < needed) {
      return {
        ok: false,
        code: 'INSUFFICIENT_CREDITS',
        message: `No active Olympus Cloud credits (${snap.availableCredits.toFixed(2)} remaining). Choose a paid plan or top-up pack at https://olympus-cloud.olympus-relay.workers.dev/cloud — or switch to your own OpenRouter / Anthropic / OpenAI key or Local Ollama.`,
        wallet: snap,
      };
    }

    st.pending[req.reservationId] = {
      id: req.reservationId,
      lane: 'paid',
      reservedCredits: needed,
      createdAt: req.nowMs,
    };
    await this.kv.put(STATE_KEY, st);
    return { ok: true, wallet: this.toSnapshot(st) };
  }

  /**
   * Reconcile an active reservation with exact streamed token charges.
   * Free-tier requests increment the daily counter; paid requests deduct `starterGift -> monthly -> topup`.
   */
  async settle(req: SettleRequest): Promise<WalletSnapshot> {
    const st = await this.load(req.nowMs);
    delete st.pending[req.reservationId];

    if (req.lane === 'free') {
      st.freeRequestsUsedToday += 1;
      await this.kv.put(STATE_KEY, st);
      return this.toSnapshot(st);
    }

    let remaining = Math.max(0, req.actualCredits);
    const fromGift = Math.min(st.starterGiftCredits, remaining);
    st.starterGiftCredits = round4(st.starterGiftCredits - fromGift);
    remaining = Math.max(0, remaining - fromGift);

    const fromMonthly = Math.min(st.monthlyCredits, remaining);
    st.monthlyCredits = round4(st.monthlyCredits - fromMonthly);
    remaining = Math.max(0, remaining - fromMonthly);

    const fromTopup = Math.min(st.topupCredits, remaining);
    st.topupCredits = round4(st.topupCredits - fromTopup);

    await this.kv.put(STATE_KEY, st);
    return this.toSnapshot(st);
  }

  /** Release a reservation without charging when every upstream fails before returning any output. */
  async release(reservationId: string, nowMs = Date.now()): Promise<WalletSnapshot> {
    const st = await this.load(nowMs);
    if (st.pending[reservationId]) {
      delete st.pending[reservationId];
      await this.kv.put(STATE_KEY, st);
    }
    return this.toSnapshot(st);
  }

  private rememberEvent(st: StoredWalletState, eventId: string): boolean {
    if (st.processedEventIds.includes(eventId)) return false;
    st.processedEventIds.push(eventId);
    if (st.processedEventIds.length > MAX_PROCESSED_EVENTS) {
      st.processedEventIds = st.processedEventIds.slice(-MAX_PROCESSED_EVENTS);
    }
    return true;
  }

  /** Idempotent subscription activation/renewal: resets monthly credit pool (no rollover) while preserving top-up credits. */
  async applySubscription(
    eventId: string,
    plan: Exclude<PlanTier, 'free'>,
    periodEndMs: number,
    nowMs = Date.now(),
  ): Promise<{ applied: boolean; wallet: WalletSnapshot }> {
    const st = await this.load(nowMs);
    if (!this.rememberEvent(st, eventId)) {
      return { applied: false, wallet: this.toSnapshot(st) };
    }
    st.plan = plan;
    st.monthlyCredits = PLANS[plan].monthlyCredits;
    st.monthlyResetAt = periodEndMs;
    await this.kv.put(STATE_KEY, st);
    return { applied: true, wallet: this.toSnapshot(st) };
  }

  /** Idempotent cancellation: downgrades plan to `free` while preserving already-purchased non-expiring top-up credits. */
  async cancelSubscription(eventId: string, nowMs = Date.now()): Promise<{ applied: boolean; wallet: WalletSnapshot }> {
    const st = await this.load(nowMs);
    if (!this.rememberEvent(st, eventId)) {
      return { applied: false, wallet: this.toSnapshot(st) };
    }
    st.plan = 'free';
    st.monthlyCredits = 0;
    st.monthlyResetAt = 0;
    await this.kv.put(STATE_KEY, st);
    return { applied: true, wallet: this.toSnapshot(st) };
  }

  /** Idempotent one-time top-up pack grant (never expires). */
  async addTopup(eventId: string, credits: number, nowMs = Date.now()): Promise<{ applied: boolean; wallet: WalletSnapshot }> {
    const st = await this.load(nowMs);
    if (!this.rememberEvent(st, eventId)) {
      return { applied: false, wallet: this.toSnapshot(st) };
    }
    st.topupCredits = round4(st.topupCredits + Math.max(0, credits));
    await this.kv.put(STATE_KEY, st);
    return { applied: true, wallet: this.toSnapshot(st) };
  }
}
