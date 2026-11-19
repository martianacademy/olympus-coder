/**
 * Pure Web-Standard HTTP router for Olympus Cloud (`olympus-cloud` Cloudflare Worker).
 * Decoupled from Cloudflare runtime globals so the exact production request handler runs identically
 * in both Cloudflare Workers (`index.ts`) and zero-dependency Node unit/integration tests.
 */

import { extractBearerOrApiKey, generateOlympusToken, sha256Hex, verifyWebhookSignature } from './auth.js';
import { handleGitHubOAuthCallback, handleGitHubOAuthStart, type OAuthConfig } from './oauth.js';
import { buildCheckoutRedirectUrl, renderLandingPage, type CheckoutLinksConfig } from './portal.js';
import {
  computeCreditsForUsage,
  estimateRequestTokens,
  FREE_MAX_ESTIMATED_INPUT_TOKENS,
  MODEL_CATALOG,
  PAID_MIN_RESERVE_CREDITS,
  PLANS,
  USD_PER_CREDIT,
  resolveModelSpec,
} from './pricing.js';
import { proxyWithFailover, type BudgetController } from './router.js';
import type {
  ApiProtocol,
  AuthenticatedUser,
  BillingWebhookEvent,
  CloudMetadataStore,
  PlanTier,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  UpstreamCredential,
  UpstreamId,
  WalletSnapshot,
} from './types.js';

export interface WalletClient {
  snapshot(nowMs?: number): Promise<WalletSnapshot>;
  grantStarterGift(nowMs?: number): Promise<{ granted: boolean; wallet: WalletSnapshot }>;
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  settle(req: SettleRequest): Promise<WalletSnapshot>;
  release(reservationId: string, nowMs?: number): Promise<WalletSnapshot>;
  applySubscription(eventId: string, plan: Exclude<PlanTier, 'free'>, periodEndMs: number, nowMs?: number): Promise<{ applied: boolean; wallet: WalletSnapshot }>;
  cancelSubscription(eventId: string, nowMs?: number): Promise<{ applied: boolean; wallet: WalletSnapshot }>;
  addTopup(eventId: string, credits: number, nowMs?: number): Promise<{ applied: boolean; wallet: WalletSnapshot }>;
}

export interface GlobalBudgetClient extends BudgetController {
  checkFreeAllowed(dailyUsdCap: number, nowMs?: number): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }>;
  recordFreeSpend(usd: number, nowMs?: number): Promise<void>;
}

export interface CloudAppDeps {
  metadata: CloudMetadataStore;
  getWallet: (userId: string) => WalletClient;
  budget: GlobalBudgetClient;
  upstreams: Partial<Record<UpstreamId, UpstreamCredential>>;
  globalFreeDailyUsdCap: number;
  freeDailyReqLimitOverride?: number;
  webhookSecret?: string;
  oauth?: OAuthConfig;
  checkoutLinks?: CheckoutLinksConfig;
  allowDevAuth?: boolean;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function isOfficialOnlyHeader(req: Request): boolean {
  const v = (req.headers.get('x-olympus-official-only') ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

export function createCloudApp(deps: CloudAppDeps) {
  const nowFn = deps.nowMs ?? (() => Date.now());

  async function authenticate(req: Request): Promise<AuthenticatedUser | null> {
    const raw = extractBearerOrApiKey(req);
    if (!raw) return null;
    const hash = await sha256Hex(raw);
    return deps.metadata.lookupToken(hash);
  }

  async function handleCompletion(req: Request, protocol: ApiProtocol, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
    const user = await authenticate(req);
    if (!user) {
      return jsonError(401, 'UNAUTHORIZED', 'Sign in to Olympus Cloud (`oly login`) to use Olympus Cloud models.');
    }

    const rawText = await req.text();
    let bodyObj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
      }
      bodyObj = parsed as Record<string, unknown>;
    } catch {
      return jsonError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
    }

    const rawModel = typeof bodyObj.model === 'string' ? bodyObj.model.trim() : '';
    const model = resolveModelSpec(rawModel);
    if (!model) {
      return jsonError(400, 'UNKNOWN_MODEL', `Unknown Olympus Cloud model "${rawModel}". Call GET /v1/models for available models.`);
    }

    const lane: 'free' | 'paid' = model.freeEligible ? 'free' : 'paid';
    const estTokens = estimateRequestTokens(rawText);
    if (lane === 'free' && estTokens > FREE_MAX_ESTIMATED_INPUT_TOKENS) {
      return jsonError(
        400,
        'FREE_CONTEXT_LIMIT',
        `Free-tier requests are capped at ${FREE_MAX_ESTIMATED_INPUT_TOKENS.toLocaleString()} estimated input tokens (got ~${estTokens.toLocaleString()}). Compact your chat or switch to a paid model.`,
      );
    }

    if (lane === 'free') {
      const globalCheck = await deps.budget.checkFreeAllowed(deps.globalFreeDailyUsdCap, nowFn());
      if (!globalCheck.allowed) {
        return jsonError(
          503,
          'FREE_TIER_PAUSED',
          'Olympus Cloud free-tier daily capacity is temporarily reached. Use your paid credits, BYO API key, or try again after UTC midnight.',
        );
      }
    }

    const wallet = deps.getWallet(user.userId);
    const reservationId = crypto.randomUUID();
    const freeLimit = deps.freeDailyReqLimitOverride ?? PLANS[user.plan].freeDailyReqLimit;
    const reserveRes = await wallet.reserve({
      reservationId,
      lane,
      minCredits: lane === 'paid' ? PAID_MIN_RESERVE_CREDITS : 0,
      freeDailyLimit: freeLimit,
      nowMs: nowFn(),
    });
    if (!reserveRes.ok) {
      const status = reserveRes.code === 'FREE_DAILY_LIMIT' ? 429 : 402;
      return jsonError(status, reserveRes.code ?? 'QUOTA_EXCEEDED', reserveRes.message ?? 'Quota exceeded.');
    }

    const officialOnly = user.officialOnly || isOfficialOnlyHeader(req);
    const result = await proxyWithFailover({
      model,
      protocol,
      rawBody: bodyObj,
      officialOnly,
      upstreams: deps.upstreams,
      budget: deps.budget,
      fetchImpl: deps.fetchImpl,
      nowMs: nowFn,
      waitUntil,
      onComplete: async ({ upstream, statusCode, latencyMs, usage }) => {
        const { costUsd, credits } = computeCreditsForUsage(model, usage);
        await wallet.settle({
          reservationId,
          actualCredits: credits,
          lane,
          nowMs: nowFn(),
        });
        if (lane === 'free') {
          await deps.budget.recordFreeSpend(costUsd, nowFn());
        }
        await deps.metadata.recordUsage({
          id: crypto.randomUUID(),
          userId: user.userId,
          createdAt: nowFn(),
          model: model.id,
          upstream,
          lane,
          usage,
          upstreamCostUsd: costUsd,
          creditsCharged: credits,
          statusCode,
          latencyMs,
        });
      },
    });

    if ('errorResponse' in result) {
      await wallet.release(reservationId, nowFn());
      return result.errorResponse;
    }

    return result.response;
  }

  async function handleBillingWebhook(req: Request): Promise<Response> {
    const rawBody = await req.text();
    const sig = req.headers.get('x-olympus-signature') ?? req.headers.get('webhook-signature');
    const valid = await verifyWebhookSignature(rawBody, sig, deps.webhookSecret);
    if (!valid) return jsonError(401, 'INVALID_SIGNATURE', 'Invalid billing webhook signature.');

    let ev: BillingWebhookEvent;
    try {
      ev = JSON.parse(rawBody) as BillingWebhookEvent;
    } catch {
      return jsonError(400, 'INVALID_JSON', 'Webhook body must be valid JSON.');
    }
    if (!ev?.eventId || !ev?.userId || !ev?.type) {
      return jsonError(400, 'INVALID_EVENT', 'Missing eventId, userId, or type.');
    }

    const wallet = deps.getWallet(ev.userId);
    if ((ev.type === 'subscription.active' || ev.type === 'subscription.renewed') && ev.plan) {
      const periodEnd = ev.periodEndMs ?? nowFn() + 30 * 86_400_000;
      const out = await wallet.applySubscription(ev.eventId, ev.plan, periodEnd, nowFn());
      if (out.applied) {
        await deps.metadata.updateUserPlan(ev.userId, ev.plan, periodEnd, ev.provider, ev.eventId);
      }
      return Response.json({ ok: true, applied: out.applied, wallet: out.wallet });
    }

    if (ev.type === 'subscription.cancelled') {
      const out = await wallet.cancelSubscription(ev.eventId, nowFn());
      if (out.applied) {
        await deps.metadata.updateUserPlan(ev.userId, 'free', 0, ev.provider, ev.eventId);
      }
      return Response.json({ ok: true, applied: out.applied, wallet: out.wallet });
    }

    if (ev.type === 'order.paid' && typeof ev.topupCredits === 'number' && ev.topupCredits > 0) {
      const out = await wallet.addTopup(ev.eventId, ev.topupCredits, nowFn());
      return Response.json({ ok: true, applied: out.applied, wallet: out.wallet });
    }

    return jsonError(400, 'UNSUPPORTED_EVENT', `Unsupported billing webhook event "${ev.type}".`);
  }

  return {
    async fetch(req: Request, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        return Response.json({ ok: true, service: 'olympus-cloud', zeroContentLogging: true });
      }

      if (req.method === 'GET' && (path === '/' || path === '/cloud')) {
        return new Response(renderLandingPage(url.origin), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' },
        });
      }

      if (req.method === 'GET' && path === '/v1/auth/github/start') {
        return handleGitHubOAuthStart(req, deps.oauth ?? {}, nowFn());
      }

      if (req.method === 'GET' && path === '/v1/auth/github/callback') {
        return handleGitHubOAuthCallback(req, deps.oauth ?? {}, deps.metadata, deps.getWallet, deps.fetchImpl ?? fetch, nowFn());
      }

      if (req.method === 'POST' && path === '/v1/billing/checkout') {
        const ctype = (req.headers.get('content-type') ?? '').toLowerCase();
        let target = '';
        let formToken = '';
        if (ctype.includes('application/x-www-form-urlencoded')) {
          const params = new URLSearchParams(await req.text());
          target = params.get('target')?.trim() ?? '';
          formToken = params.get('token')?.trim() ?? '';
        } else {
          const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          target = typeof j.target === 'string' ? j.target.trim() : '';
        }
        const bearer = extractBearerOrApiKey(req) ?? (formToken || undefined);
        const user = bearer ? await deps.metadata.lookupToken(await sha256Hex(bearer)) : null;
        if (!user) return jsonError(401, 'UNAUTHORIZED', 'Sign in to Olympus Cloud before starting checkout.');
        const redirectUrl = buildCheckoutRedirectUrl(target, user, deps.checkoutLinks ?? {});
        if (!redirectUrl) return jsonError(503, 'CHECKOUT_NOT_CONFIGURED', `Checkout link for "${target}" is not configured yet.`);
        if (ctype.includes('application/x-www-form-urlencoded')) {
          return new Response(null, { status: 303, headers: { Location: redirectUrl, 'Referrer-Policy': 'no-referrer' } });
        }
        return Response.json({ checkoutUrl: redirectUrl });
      }

      if (req.method === 'GET' && path === '/v1/models') {
        return Response.json({
          object: 'list',
          data: MODEL_CATALOG.map((m) => ({
            id: m.id,
            object: 'model',
            owned_by: 'olympus-cloud',
            name: m.name,
            group: m.group,
            context_length: m.contextWindow,
            free_eligible: m.freeEligible,
            pricing: {
              prompt: String(Number((m.officialRates.inputUsd / 1_000_000).toPrecision(10))),
              completion: String(Number((m.officialRates.outputUsd / 1_000_000).toPrecision(10))),
              usd_per_credit: USD_PER_CREDIT,
            },
          })),
        });
      }

      if (req.method === 'GET' && path === '/v1/account/credits') {
        const user = await authenticate(req);
        if (!user) return jsonError(401, 'UNAUTHORIZED', 'Valid Olympus Cloud token required.');
        const wallet = await deps.getWallet(user.userId).snapshot(nowFn());
        return Response.json({
          userId: user.userId,
          email: user.email,
          officialOnly: user.officialOnly,
          usdPerCredit: USD_PER_CREDIT,
          plans: PLANS,
          wallet,
        });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        return handleCompletion(req, 'openai', waitUntil);
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        return handleCompletion(req, 'anthropic', waitUntil);
      }

      if (req.method === 'POST' && path === '/v1/webhooks/billing') {
        return handleBillingWebhook(req);
      }

      if (req.method === 'POST' && path === '/v1/auth/dev-issue') {
        if (!deps.allowDevAuth || !deps.metadata.upsertDevUser) {
          return jsonError(404, 'NOT_FOUND', 'Not found.');
        }
        const body = (await req.json().catch(() => ({}))) as {
          userId?: string;
          email?: string;
          plan?: PlanTier;
          officialOnly?: boolean;
          githubVerified?: boolean;
        };
        const userId = body.userId?.trim() || `usr_${crypto.randomUUID().slice(0, 8)}`;
        const user: AuthenticatedUser = {
          userId,
          email: body.email?.trim() || `${userId}@local.test`,
          plan: body.plan ?? 'free',
          officialOnly: Boolean(body.officialOnly),
          githubVerified: body.githubVerified !== false,
        };
        const token = generateOlympusToken();
        const tokenHash = await sha256Hex(token);
        await deps.metadata.upsertDevUser(user, tokenHash);
        const wallet = deps.getWallet(userId);
        if (user.plan !== 'free') {
          await wallet.applySubscription(`dev_init_${userId}`, user.plan, nowFn() + 30 * 86_400_000, nowFn());
        }
        return Response.json({ token, user, wallet: await wallet.snapshot(nowFn()) }, { status: 201 });
      }

      return jsonError(404, 'NOT_FOUND', `Unknown route ${req.method} ${path}`);
    },
  };
}
