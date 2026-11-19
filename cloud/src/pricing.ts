/**
 * Official-rate pricing floor, paid plan definitions ($20 / $60 / $100 + $10 top-up), and exact token-to-credit
 * accounting for Olympus Cloud.
 *
 * Paid-only invariant:
 * - Olympus Cloud serves paid credit plans and top-up packs only (no free daily proxy pool or starter gift),
 *   so zero unpaid traffic can ever consume upstream API keys. Users who want $0 coding can use BYO keys
 *   (OpenRouter, Anthropic, OpenAI, Vercel AI Gateway), Local Ollama, or any of the 18 free CLIs in Olympus Coder.
 *
 * Pricing floor invariant:
 * - Every credit deduction is computed strictly from official commercial API baseline rates.
 * - `USD_PER_CREDIT = 0.0075` ($7.50 per 1,000 credits):
 *   - Starter ($20/mo -> ~$18.30 net after MoR): 2,000 credits = $15.00 hard max API cost -> worst-case +$3.30 profit.
 *   - Pro     ($60/mo -> ~$55.90 net after MoR): 6,200 credits = $46.50 hard max API cost -> worst-case +$9.40 profit.
 *   - Max    ($100/mo -> ~$93.50 net after MoR): 10,500 credits = $78.75 hard max API cost -> worst-case +$14.75 profit.
 * - Any cheaper temporary promo upstream lowers actual upstream cost without inflating promised credit pools.
 */

import type { ModelRatesPerMillion, ModelSpec, PlanConfig, PlanTier, TokenUsageCounts } from './types.js';

export const USD_PER_CREDIT = 0.0075;
/** Paid-only policy: new signups start at 0 credits until a paid plan or top-up pack is purchased. */
export const STARTER_GIFT_CREDITS = 0;
/** Minimum pre-flight credit reservation per paid request to prevent concurrent parallel overdraft. */
export const PAID_MIN_RESERVE_CREDITS = 2;
/** Retained constant for legacy free-lane callers (unused in paid-only mode). */
export const FREE_MAX_ESTIMATED_INPUT_TOKENS = 64_000;

export const PLANS: Record<PlanTier, PlanConfig> = {
  free: {
    tier: 'free',
    priceUsd: 0,
    monthlyCredits: 0,
    maxApiCostUsd: 0,
    freeDailyReqLimit: 0,
  },
  starter: {
    tier: 'starter',
    priceUsd: 20,
    monthlyCredits: 2_000,
    maxApiCostUsd: 15.0,
    freeDailyReqLimit: 0,
  },
  pro: {
    tier: 'pro',
    priceUsd: 60,
    monthlyCredits: 6_200,
    maxApiCostUsd: 46.5,
    freeDailyReqLimit: 0,
  },
  max: {
    tier: 'max',
    priceUsd: 100,
    monthlyCredits: 10_500,
    maxApiCostUsd: 78.75,
    freeDailyReqLimit: 0,
  },
};

function rates(inputUsd: number, outputUsd: number, cacheReadUsd: number, write5mFactor = 1.25, write1hFactor = 2.0): ModelRatesPerMillion {
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWrite5mUsd: Number((inputUsd * write5mFactor).toPrecision(6)),
    cacheWrite1hUsd: Number((inputUsd * write1hFactor).toPrecision(6)),
  };
}

/**
 * Curated paid-only Olympus Cloud model catalog with official baseline rates and pluggable failover routes.
 * Optional `promo` routes are attempted only when configured, healthy in `GlobalBudgetDO`, AND not bypassed by `officialOnly`.
 */
export const MODEL_CATALOG: ModelSpec[] = [
  // --- High-value coding models (10x-20x longer runway per credit) ---
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5 (1M)',
    group: 'value',
    contextWindow: 1_000_000,
    freeEligible: false,
    officialRates: rates(0.1, 0.5, 0.01),
    routes: [
      { upstream: 'anthropic', upstreamModel: 'claude-haiku-5-5', official: true, protocol: 'anthropic' },
      { upstream: 'openrouter', upstreamModel: 'anthropic/claude-haiku-5.5', official: true, protocol: 'openai' },
    ],
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    group: 'value',
    contextWindow: 163_840,
    freeEligible: false,
    officialRates: rates(0.3, 1.2, 0.03, 1, 1),
    routes: [
      { upstream: 'deepseek', upstreamModel: 'deepseek-chat', official: true, protocol: 'openai' },
      { upstream: 'openrouter', upstreamModel: 'deepseek/deepseek-chat-v3-0324', official: true, protocol: 'openai' },
    ],
  },
  {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3 Code',
    group: 'value',
    contextWindow: 256_000,
    freeEligible: false,
    officialRates: rates(0.6, 2.5, 0.15, 1, 1),
    routes: [
      { upstream: 'kimi', upstreamModel: 'kimi-k3', official: true, protocol: 'openai' },
      { upstream: 'openrouter', upstreamModel: 'moonshotai/kimi-k2', official: true, protocol: 'openai' },
    ],
  },

  // --- Frontier coding & architecture models ---
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5 (1M)',
    group: 'frontier',
    contextWindow: 1_000_000,
    freeEligible: false,
    officialRates: rates(2.0, 10.0, 0.1),
    routes: [
      { upstream: 'promo', upstreamModel: 'anthropic/claude-sonnet-5-5', official: false, protocol: 'openai' },
      { upstream: 'anthropic', upstreamModel: 'claude-sonnet-5-5', official: true, protocol: 'anthropic' },
      { upstream: 'openrouter', upstreamModel: 'anthropic/claude-sonnet-5.5', official: true, protocol: 'openai' },
    ],
  },
  {
    id: 'anthropic/claude-opus-5.5',
    name: 'Claude Opus 5.5 (1M)',
    group: 'frontier',
    contextWindow: 1_000_000,
    freeEligible: false,
    officialRates: rates(4.0, 20.0, 0.2),
    routes: [
      { upstream: 'promo', upstreamModel: 'anthropic/claude-opus-5-5', official: false, protocol: 'openai' },
      { upstream: 'anthropic', upstreamModel: 'claude-opus-5-5', official: true, protocol: 'anthropic' },
      { upstream: 'openrouter', upstreamModel: 'anthropic/claude-opus-5.5', official: true, protocol: 'openai' },
    ],
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    group: 'frontier',
    contextWindow: 400_000,
    freeEligible: false,
    officialRates: rates(1.25, 10.0, 0.125, 1, 1),
    routes: [
      { upstream: 'promo', upstreamModel: 'openai/gpt-5.5', official: false, protocol: 'openai' },
      { upstream: 'openrouter', upstreamModel: 'openai/gpt-5', official: true, protocol: 'openai' },
    ],
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro (1M)',
    group: 'frontier',
    contextWindow: 1_000_000,
    freeEligible: false,
    officialRates: rates(1.25, 10.0, 0.3125, 1, 1),
    routes: [
      { upstream: 'openrouter', upstreamModel: 'google/gemini-2.5-pro', official: true, protocol: 'openai' },
    ],
  },
];

const ALIAS_MAP = new Map<string, string>([
  ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
  ['claude-opus-5-5', 'anthropic/claude-opus-5.5'],
  ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5'],
  ['gpt-5', 'openai/gpt-5'],
  ['kimi-k3', 'moonshotai/kimi-k3'],
]);

/** Look up a catalog model by canonical ID or common shorthand alias. */
export function resolveModelSpec(rawModelId: string): ModelSpec | undefined {
  const clean = rawModelId.trim().toLowerCase();
  const canonical = ALIAS_MAP.get(clean) ?? clean;
  return MODEL_CATALOG.find((m) => m.id.toLowerCase() === canonical);
}

/** Calculate official baseline USD cost for a completion step, including Haiku 5.5 >100k tiering. */
export function computeOfficialCostUsd(model: ModelSpec, usage: TokenUsageCounts): number {
  const totalPrompt = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens + usage.cachedWrite1hTokens;
  let r = model.officialRates;
  if (model.id === 'anthropic/claude-haiku-5.5' && totalPrompt > 100_000) {
    r = rates(0.5, 2.5, 0.05);
  }
  const usd =
    (usage.inputTokens * r.inputUsd +
      usage.cachedReadTokens * r.cacheReadUsd +
      usage.cachedWriteTokens * r.cacheWrite5mUsd +
      usage.cachedWrite1hTokens * r.cacheWrite1hUsd +
      usage.outputTokens * r.outputUsd) /
    1_000_000;
  return Number(Math.max(0, usd).toFixed(8));
}

/** Convert official baseline USD cost into Olympus Credits (`0` for free-eligible models). */
export function computeCreditsForUsage(model: ModelSpec, usage: TokenUsageCounts): { costUsd: number; credits: number } {
  if (model.freeEligible) {
    return { costUsd: 0, credits: 0 };
  }
  const costUsd = computeOfficialCostUsd(model, usage);
  const credits = costUsd > 0 ? Number((costUsd / USD_PER_CREDIT).toFixed(4)) : 0;
  return { costUsd, credits };
}

/** Conservative fast token estimate (`chars / 3.5`) for enforcing free-tier input caps before proxying. */
export function estimateRequestTokens(bodyText: string): number {
  return Math.ceil(bodyText.length / 3.5);
}
