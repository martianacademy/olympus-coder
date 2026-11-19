/**
 * Cloudflare Worker entrypoint for Olympus Cloud (`olympus-cloud`).
 * Wires `UserWalletDO`, `GlobalBudgetDO`, D1 zero-content-logging metadata storage,
 * and server-side upstream API credentials into `createCloudApp()`.
 */

import { DurableObject } from 'cloudflare:workers';
import { createCloudApp, type GlobalBudgetClient, type WalletClient } from './app.js';
import { BudgetCore } from './budgetCore.js';
import { WalletCore } from './walletCore.js';
import type {
  AuthenticatedUser,
  CloudMetadataStore,
  OAuthUpsertInput,
  PlanTier,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  UpstreamCredential,
  UpstreamId,
  UsageLedgerRow,
  WalletSnapshot,
} from './types.js';

export interface WorkerEnv {
  WALLETS: DurableObjectNamespace;
  GLOBAL_BUDGET: DurableObjectNamespace;
  DB: D1Database;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  KIMI_API_KEY?: string;
  KIMI_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  PROMO_API_KEY?: string;
  PROMO_BASE_URL?: string;
  BILLING_WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_STATE_SECRET?: string;
  CHECKOUT_STARTER_URL?: string;
  CHECKOUT_PRO_URL?: string;
  CHECKOUT_MAX_URL?: string;
  CHECKOUT_TOPUP10_URL?: string;
  GLOBAL_FREE_DAILY_USD_CAP?: string;
  FREE_DAILY_REQ_LIMIT?: string;
  ALLOW_DEV_AUTH?: string;
}

class D1MetadataStore implements CloudMetadataStore {
  constructor(private readonly db: D1Database) {}

  async lookupToken(tokenHash: string): Promise<AuthenticatedUser | null> {
    const row = await this.db
      .prepare(
        `SELECT u.id, u.email, u.plan, u.official_only, u.github_id
         FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      )
      .bind(tokenHash)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      userId: String(row.id),
      email: String(row.email),
      plan: String(row.plan) as PlanTier,
      officialOnly: Number(row.official_only ?? 0) === 1,
      githubVerified: Boolean(row.github_id),
    };
  }

  async upsertOAuthUser(
    input: OAuthUpsertInput,
    tokenHash: string,
    label = 'cli',
  ): Promise<{ user: AuthenticatedUser; isNewUser: boolean }> {
    const now = Date.now();
    const existing = await this.db
      .prepare(`SELECT id, email, plan, official_only FROM users WHERE github_id = ? OR email = ?`)
      .bind(input.githubId, input.email)
      .first<Record<string, unknown>>();
    const userId = existing ? String(existing.id) : `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (existing) {
      await this.db
        .prepare(`UPDATE users SET github_id = ?, github_created_at = ?, email = ?, updated_at = ? WHERE id = ?`)
        .bind(input.githubId, input.githubCreatedAtMs, input.email, now, userId)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO users (id, email, github_id, github_created_at, plan, official_only, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'free', 0, ?, ?)`,
        )
        .bind(userId, input.email, input.githubId, input.githubCreatedAtMs, now, now)
        .run();
    }
    await this.db
      .prepare(`INSERT INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)`)
      .bind(tokenHash, userId, label, now)
      .run();
    return {
      user: {
        userId,
        email: input.email,
        plan: existing ? (String(existing.plan) as PlanTier) : 'free',
        officialOnly: existing ? Number(existing.official_only ?? 0) === 1 : false,
        githubVerified: true,
      },
      isNewUser: !existing,
    };
  }

  async upsertDevUser(user: AuthenticatedUser, tokenHash: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO users (id, email, github_id, plan, official_only, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, official_only = excluded.official_only, updated_at = excluded.updated_at`,
      )
      .bind(user.userId, user.email, user.githubVerified ? `gh_${user.userId}` : null, user.plan, user.officialOnly ? 1 : 0, now, now)
      .run();
    await this.db
      .prepare(`INSERT OR REPLACE INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, 'dev', ?)`)
      .bind(tokenHash, user.userId, now)
      .run();
  }

  async updateUserPlan(userId: string, plan: PlanTier, periodEndMs = 0, provider = 'dodo', subId = ''): Promise<void> {
    const now = Date.now();
    await this.db.prepare(`UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`).bind(plan, now, userId).run();
    if (subId) {
      await this.db
        .prepare(
          `INSERT INTO subscriptions (id, user_id, provider, plan, status, current_period_end, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`,
        )
        .bind(subId, userId, provider, plan, plan === 'free' ? 'cancelled' : 'active', periodEndMs, now)
        .run();
    }
  }

  async recordUsage(row: UsageLedgerRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage_ledger (
           id, user_id, created_at, model, upstream, lane,
           input_tokens, cached_read_tokens, cached_write_tokens, cached_write_1h_tokens, output_tokens,
           upstream_cost_usd, credits_charged, status_code, latency_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.userId,
        row.createdAt,
        row.model,
        row.upstream,
        row.lane,
        row.usage.inputTokens,
        row.usage.cachedReadTokens,
        row.usage.cachedWriteTokens,
        row.usage.cachedWrite1hTokens,
        row.usage.outputTokens,
        row.upstreamCostUsd,
        row.creditsCharged,
        row.statusCode,
        row.latencyMs,
      )
      .run();
  }
}

async function doJson<T>(stub: DurableObjectStub, path: string, payload?: unknown): Promise<T> {
  const res = await stub.fetch(`https://do.internal${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  return (await res.json()) as T;
}

function walletStubClient(stub: DurableObjectStub, userId: string): WalletClient {
  return {
    snapshot: (nowMs) => doJson<WalletSnapshot>(stub, '/snapshot', { userId, nowMs }),
    grantStarterGift: (nowMs) => doJson(stub, '/starter-gift', { userId, nowMs }),
    reserve: (req: ReserveRequest) => doJson<ReserveResult>(stub, '/reserve', { userId, ...req }),
    settle: (req: SettleRequest) => doJson<WalletSnapshot>(stub, '/settle', { userId, ...req }),
    release: (reservationId, nowMs) => doJson<WalletSnapshot>(stub, '/release', { userId, reservationId, nowMs }),
    applySubscription: (eventId, plan, periodEndMs, nowMs) => doJson(stub, '/subscription', { userId, eventId, plan, periodEndMs, nowMs }),
    cancelSubscription: (eventId, nowMs) => doJson(stub, '/cancel', { userId, eventId, nowMs }),
    addTopup: (eventId, credits, nowMs) => doJson(stub, '/topup', { userId, eventId, credits, nowMs }),
  };
}

function budgetStubClient(stub: DurableObjectStub): GlobalBudgetClient {
  return {
    checkFreeAllowed: (dailyUsdCap, nowMs) => doJson(stub, '/check-free', { dailyUsdCap, nowMs }),
    recordFreeSpend: async (usd, nowMs) => {
      await doJson(stub, '/record-free', { usd, nowMs });
    },
    isUpstreamHealthy: async (upstream, nowMs) => (await doJson<{ healthy: boolean }>(stub, '/healthy', { upstream, nowMs })).healthy,
    recordUpstreamSuccess: async (upstream, nowMs) => {
      await doJson(stub, '/success', { upstream, nowMs });
    },
    recordUpstreamFailure: (upstream, reason, nowMs) => doJson(stub, '/failure', { upstream, reason, nowMs }),
  };
}

function readUpstreams(env: WorkerEnv): Partial<Record<UpstreamId, UpstreamCredential>> {
  const out: Partial<Record<UpstreamId, UpstreamCredential>> = {};
  if (env.OPENROUTER_API_KEY) {
    out.openrouter = {
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      protocol: 'openai',
      extraHeaders: { 'HTTP-Referer': 'https://olympuscoder.app', 'X-Title': 'Olympus Cloud' },
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    out.anthropic = {
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      apiKey: env.ANTHROPIC_API_KEY,
      protocol: 'anthropic',
    };
  }
  if (env.KIMI_API_KEY) {
    out.kimi = {
      baseUrl: env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
      apiKey: env.KIMI_API_KEY,
      protocol: 'openai',
    };
  }
  if (env.DEEPSEEK_API_KEY) {
    out.deepseek = {
      baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: env.DEEPSEEK_API_KEY,
      protocol: 'openai',
    };
  }
  if (env.PROMO_API_KEY && env.PROMO_BASE_URL) {
    out.promo = {
      baseUrl: env.PROMO_BASE_URL,
      apiKey: env.PROMO_API_KEY,
      protocol: 'openai',
    };
  }
  return out;
}

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const app = createCloudApp({
      metadata: new D1MetadataStore(env.DB),
      getWallet: (userId) => walletStubClient(env.WALLETS.get(env.WALLETS.idFromName(userId)), userId),
      budget: budgetStubClient(env.GLOBAL_BUDGET.get(env.GLOBAL_BUDGET.idFromName('global'))),
      upstreams: readUpstreams(env),
      globalFreeDailyUsdCap: Number(env.GLOBAL_FREE_DAILY_USD_CAP ?? 0),
      freeDailyReqLimitOverride: env.FREE_DAILY_REQ_LIMIT !== undefined ? Number(env.FREE_DAILY_REQ_LIMIT) : 0,
      webhookSecret: env.BILLING_WEBHOOK_SECRET,
      oauth: {
        githubClientId: env.GITHUB_CLIENT_ID,
        githubClientSecret: env.GITHUB_CLIENT_SECRET,
        oauthStateSecret: env.OAUTH_STATE_SECRET,
      },
      checkoutLinks: {
        starterUrl: env.CHECKOUT_STARTER_URL,
        proUrl: env.CHECKOUT_PRO_URL,
        maxUrl: env.CHECKOUT_MAX_URL,
        topup10Url: env.CHECKOUT_TOPUP10_URL,
      },
      allowDevAuth: env.ALLOW_DEV_AUTH === 'true',
    });
    return app.fetch(req, (p) => ctx.waitUntil(p));
  },
};

export class UserWalletDO extends DurableObject<WorkerEnv> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const core = new WalletCore(this.ctx.storage, String(body.userId ?? 'unknown'));
    const nowMs = typeof body.nowMs === 'number' ? body.nowMs : Date.now();
    switch (url.pathname) {
      case '/snapshot':
        return Response.json(await core.snapshot(nowMs));
      case '/starter-gift':
        return Response.json(await core.grantStarterGift(nowMs));
      case '/reserve':
        return Response.json(await core.reserve(body as unknown as ReserveRequest));
      case '/settle':
        return Response.json(await core.settle(body as unknown as SettleRequest));
      case '/release':
        return Response.json(await core.release(String(body.reservationId ?? ''), nowMs));
      case '/subscription':
        return Response.json(
          await core.applySubscription(String(body.eventId), body.plan as Exclude<PlanTier, 'free'>, Number(body.periodEndMs), nowMs),
        );
      case '/cancel':
        return Response.json(await core.cancelSubscription(String(body.eventId), nowMs));
      case '/topup':
        return Response.json(await core.addTopup(String(body.eventId), Number(body.credits), nowMs));
      default:
        return Response.json({ error: 'unknown wallet route' }, { status: 404 });
    }
  }
}

export class GlobalBudgetDO extends DurableObject<WorkerEnv> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const core = new BudgetCore(this.ctx.storage);
    const nowMs = typeof body.nowMs === 'number' ? body.nowMs : Date.now();
    switch (url.pathname) {
      case '/check-free':
        return Response.json(await core.checkFreeAllowed(Number(body.dailyUsdCap ?? 10), nowMs));
      case '/record-free':
        await core.recordFreeSpend(Number(body.usd ?? 0), nowMs);
        return Response.json({ ok: true });
      case '/healthy':
        return Response.json({ healthy: await core.isUpstreamHealthy(body.upstream as UpstreamId, nowMs) });
      case '/success':
        await core.recordUpstreamSuccess(body.upstream as UpstreamId, nowMs);
        return Response.json({ ok: true });
      case '/failure':
        return Response.json(await core.recordUpstreamFailure(body.upstream as UpstreamId, String(body.reason ?? ''), nowMs));
      default:
        return Response.json({ error: 'unknown budget route' }, { status: 404 });
    }
  }
}
