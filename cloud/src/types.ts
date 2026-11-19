/**
 * Shared domain types for Olympus Cloud — stateless zero-content-logging credit gateway.
 */

export type PlanTier = 'free' | 'starter' | 'pro' | 'max';

export type ApiProtocol = 'openai' | 'anthropic';

export type UpstreamId = 'openrouter' | 'anthropic' | 'kimi' | 'deepseek' | 'promo';

export interface ModelRatesPerMillion {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
}

export interface UpstreamRoute {
  upstream: UpstreamId;
  /** Upstream model ID sent in the proxied request body. */
  upstreamModel: string;
  /** True for official commercial ZDR-capable providers; false for optional discounted promo upstreams. */
  official: boolean;
  /** Native wire protocol supported by this upstream route. */
  protocol: ApiProtocol;
}

export interface ModelSpec {
  id: string;
  name: string;
  group: 'free' | 'value' | 'frontier';
  contextWindow: number;
  /** Free-tier daily quota applies when true; paid credits apply otherwise. */
  freeEligible: boolean;
  /** Official baseline rates used for pricing floor & user credit billing (never drops below official floor). */
  officialRates: ModelRatesPerMillion;
  /** Ordered failover routes: optional bonus promo first (unless `officialOnly`), then official commercial upstreams. */
  routes: UpstreamRoute[];
}

export interface PlanConfig {
  tier: PlanTier;
  priceUsd: number;
  monthlyCredits: number;
  /** Hard API cost ceiling (USD) backed by `monthlyCredits` at 25% gross margin floor. */
  maxApiCostUsd: number;
  freeDailyReqLimit: number;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  plan: PlanTier;
  officialOnly: boolean;
  githubVerified: boolean;
}

export interface PendingReservation {
  id: string;
  lane: 'free' | 'paid';
  reservedCredits: number;
  createdAt: number;
}

export interface WalletSnapshot {
  userId: string;
  plan: PlanTier;
  monthlyCredits: number;
  topupCredits: number;
  starterGiftCredits: number;
  /** Sum of active in-flight stream reservations to prevent parallel overdraft. */
  reservedCredits: number;
  /** Spendable credits right now (`starterGift + monthly + topup - reserved`). */
  availableCredits: number;
  monthlyResetAt: number;
  freeDayKey: string;
  freeRequestsUsedToday: number;
  freeDailyLimit: number;
}

export interface ReserveRequest {
  reservationId: string;
  lane: 'free' | 'paid';
  minCredits: number;
  freeDailyLimit: number;
  nowMs: number;
}

export interface ReserveResult {
  ok: boolean;
  code?: 'FREE_DAILY_LIMIT' | 'INSUFFICIENT_CREDITS';
  message?: string;
  wallet: WalletSnapshot;
}

export interface SettleRequest {
  reservationId: string;
  actualCredits: number;
  lane: 'free' | 'paid';
  nowMs: number;
}

export interface TokenUsageCounts {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  cachedWrite1hTokens: number;
  outputTokens: number;
}

export interface UsageLedgerRow {
  id: string;
  userId: string;
  createdAt: number;
  model: string;
  upstream: UpstreamId;
  lane: 'free' | 'paid';
  usage: TokenUsageCounts;
  upstreamCostUsd: number;
  creditsCharged: number;
  statusCode: number;
  latencyMs: number;
}

export interface UpstreamCredential {
  baseUrl: string;
  apiKey: string;
  protocol: ApiProtocol;
  extraHeaders?: Record<string, string>;
}

export interface BillingWebhookEvent {
  eventId: string;
  type: 'subscription.active' | 'subscription.renewed' | 'subscription.cancelled' | 'order.paid';
  provider: 'dodo' | 'polar';
  userId: string;
  plan?: Exclude<PlanTier, 'free'>;
  topupCredits?: number;
  periodEndMs?: number;
}

export interface StorageKv {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface OAuthUpsertInput {
  githubId: string;
  email: string;
  githubCreatedAtMs: number;
}

export interface CloudMetadataStore {
  lookupToken(tokenHash: string): Promise<AuthenticatedUser | null>;
  upsertOAuthUser(input: OAuthUpsertInput, tokenHash: string, label?: string): Promise<{ user: AuthenticatedUser; isNewUser: boolean }>;
  upsertDevUser?(user: AuthenticatedUser, tokenHash: string): Promise<void>;
  updateUserPlan(userId: string, plan: PlanTier, periodEndMs?: number, provider?: string, subId?: string): Promise<void>;
  recordUsage(row: UsageLedgerRow): Promise<void>;
}
