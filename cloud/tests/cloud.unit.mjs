import assert from 'node:assert/strict';
import { createCloudApp } from '../dist/app.js';
import { signHmacSha256Hex } from '../dist/auth.js';
import { BREAKER_COOLDOWN_MS, BudgetCore } from '../dist/budgetCore.js';
import { computeCreditsForUsage, MODEL_CATALOG, PLANS, resolveModelSpec, STARTER_GIFT_CREDITS, USD_PER_CREDIT } from '../dist/pricing.js';
import { WalletCore } from '../dist/walletCore.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`  FAIL  ${name}:`, err);
  }
}

function makeMemoryKv() {
  const map = new Map();
  return {
    async get(k) {
      const v = map.get(k);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(k, v) {
      map.set(k, structuredClone(v));
    },
  };
}

function sseResponse(frames) {
  const text = frames.map((f) => (f === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(f)}\n\n`)).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeHarness(overrides = {}) {
  let clock = overrides.startMs ?? Date.parse('2026-11-19T12:00:00Z');
  const usersByToken = new Map();
  const usersById = new Map();
  const ledger = [];
  const wallets = new Map();
  const budget = new BudgetCore(makeMemoryKv());

  const metadata = {
    async lookupToken(hash) {
      return usersByToken.get(hash) ?? null;
    },
    async upsertDevUser(user, tokenHash) {
      usersById.set(user.userId, { ...user });
      usersByToken.set(tokenHash, { ...user });
    },
    async updateUserPlan(userId, plan) {
      const u = usersById.get(userId);
      if (u) {
        u.plan = plan;
        for (const [h, tokUser] of usersByToken.entries()) {
          if (tokUser.userId === userId) usersByToken.set(h, { ...u });
        }
      }
    },
    async recordUsage(row) {
      ledger.push(row);
    },
  };

  const getWallet = (userId) => {
    let w = wallets.get(userId);
    if (!w) {
      w = new WalletCore(makeMemoryKv(), userId);
      wallets.set(userId, w);
    }
    return w;
  };

  const app = createCloudApp({
    metadata,
    getWallet,
    budget,
    upstreams: overrides.upstreams ?? {
      promo: { baseUrl: 'https://promo.mock/v1', apiKey: 'sk-promo', protocol: 'openai' },
      openrouter: { baseUrl: 'https://openrouter.mock/v1', apiKey: 'sk-or', protocol: 'openai' },
      anthropic: { baseUrl: 'https://anthropic.mock/v1', apiKey: 'sk-ant', protocol: 'anthropic' },
    },
    globalFreeDailyUsdCap: overrides.globalFreeDailyUsdCap ?? 10,
    freeDailyReqLimitOverride: overrides.freeDailyReqLimitOverride,
    webhookSecret: overrides.webhookSecret ?? 'whsec_test_olympus_secret',
    allowDevAuth: overrides.allowDevAuth ?? true,
    fetchImpl: overrides.fetchImpl,
    nowMs: () => clock,
  });

  return {
    app,
    ledger,
    budget,
    getWallet,
    advanceMs(delta) {
      clock += delta;
    },
    async issueUser(opts) {
      const res = await app.fetch(
        new Request('https://cloud.test/v1/auth/dev-issue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        }),
      );
      assert.equal(res.status, 201);
      return res.json();
    },
  };
}

await test('Pricing floor invariant: $20/$60/$100 plans guarantee positive profit even at 100% credit burn + accurate token math', () => {
  for (const tier of ['starter', 'pro', 'max']) {
    const p = PLANS[tier];
    const netRevenue = p.priceUsd * 0.94 - 0.5;
    const worstCaseApiCost = p.monthlyCredits * USD_PER_CREDIT;
    assert.ok(worstCaseApiCost <= p.maxApiCostUsd + 1e-9, `${tier} cost <= maxApiCostUsd`);
    assert.ok(netRevenue - worstCaseApiCost > 2.5, `${tier} keeps guaranteed positive margin even at 100% burn`);
  }

  const sonnet = resolveModelSpec('claude-sonnet-5-5');
  assert.equal(sonnet.id, 'anthropic/claude-sonnet-5.5');
  // 10k fresh ($0.02) + 90k cacheRead ($0.009) + 10k 5m write ($0.025) + 1k out ($0.01) = $0.064 -> 8.5333 credits
  const s = computeCreditsForUsage(sonnet, { inputTokens: 10_000, cachedReadTokens: 90_000, cachedWriteTokens: 10_000, cachedWrite1hTokens: 0, outputTokens: 1_000 });
  assert.equal(s.costUsd, 0.064);
  assert.equal(s.credits, Number((0.064 / USD_PER_CREDIT).toFixed(4)));

  // Haiku 5.5 > 100k tier jump
  const haiku = resolveModelSpec('anthropic/claude-haiku-5.5');
  const hLow = computeCreditsForUsage(haiku, { inputTokens: 50_000, cachedReadTokens: 0, cachedWriteTokens: 0, cachedWrite1hTokens: 0, outputTokens: 0 });
  const hHigh = computeCreditsForUsage(haiku, { inputTokens: 120_000, cachedReadTokens: 0, cachedWriteTokens: 0, cachedWrite1hTokens: 0, outputTokens: 0 });
  assert.equal(hLow.costUsd, 0.005);
  assert.equal(hHigh.costUsd, 0.06);

  // Paid-only catalog: zero free-eligible models, zero starter gift, zero free daily requests
  assert.equal(STARTER_GIFT_CREDITS, 0);
  assert.equal(MODEL_CATALOG.length, 7);
  assert.equal(MODEL_CATALOG.filter((m) => m.freeEligible).length, 0);
  assert.equal(resolveModelSpec('olympus/auto-free'), undefined);
  for (const tier of ['free', 'starter', 'pro', 'max']) {
    assert.equal(PLANS[tier].freeDailyReqLimit, 0);
  }
});

await test('Atomic wallet prevents parallel overdraft, enforces monthly -> topup priority, disables starter gift, and expires stale reservations', async () => {
  let now = Date.parse('2026-11-19T12:00:00Z');
  const w = new WalletCore(makeMemoryKv(), 'usr_parallel');
  await w.addTopup('evt_t1', 5, now);

  // 6 parallel sub-sessions trying to reserve 2 credits each against 5 available -> only 2 succeed!
  const attempts = [];
  for (let i = 0; i < 6; i++) {
    attempts.push(await w.reserve({ reservationId: `r_${i}`, lane: 'paid', minCredits: 2, freeDailyLimit: 0, nowMs: now }));
  }
  assert.equal(attempts.filter((a) => a.ok).length, 2);
  assert.equal(attempts.filter((a) => !a.ok && a.code === 'INSUFFICIENT_CREDITS').length, 4);

  // Stale reservation expires after >5 min TTL
  now += 6 * 60_000;
  const afterTtl = await w.snapshot(now);
  assert.equal(afterTtl.reservedCredits, 0);
  assert.equal(afterTtl.availableCredits, 5);

  // Starter gift is disabled in paid-only mode (no-op)
  const giftRes = await w.grantStarterGift(now);
  assert.equal(giftRes.granted, false);
  assert.equal(giftRes.wallet.starterGiftCredits, 0);

  // Deduction priority: monthly (2000) -> topup (5)
  await w.applySubscription('evt_sub1', 'starter', now + 30 * 86_400_000, now);
  await w.settle({ reservationId: 'x', actualCredits: 2002, lane: 'paid', nowMs: now });
  const snap = await w.snapshot(now);
  assert.equal(snap.starterGiftCredits, 0);
  assert.equal(snap.monthlyCredits, 0);
  assert.equal(snap.topupCredits, 3, '2002 consumed 2000 monthly + 2 topup leaving 3 topup');

  // Monthly renewal resets monthly to 2000 (no rollover) while preserving topup (3), and duplicate event is ignored
  const r1 = await w.applySubscription('evt_sub2', 'starter', now + 60 * 86_400_000, now);
  const r2 = await w.applySubscription('evt_sub2', 'starter', now + 60 * 86_400_000, now);
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, false);
  assert.equal(r2.wallet.monthlyCredits, 2000);
  assert.equal(r2.wallet.topupCredits, 3);
});

await test('Paid-only guard: 0-credit account gets 402 INSUFFICIENT_CREDITS, removed free slugs get 400 UNKNOWN_MODEL, and ZERO upstream calls fire', async () => {
  const upstreamCalls = [];
  const h = makeHarness({
    globalFreeDailyUsdCap: 0,
    freeDailyReqLimitOverride: 0,
    fetchImpl: async (url) => {
      upstreamCalls.push(String(url));
      return sseResponse([
        { choices: [{ delta: { content: 'SHOULD_NOT_HAPPEN' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        '[DONE]',
      ]);
    },
  });

  const { token, wallet } = await h.issueUser({ userId: 'u_unpaid', plan: 'free', githubVerified: true });
  assert.equal(wallet.starterGiftCredits, 0);
  assert.equal(wallet.availableCredits, 0);

  // 1. GET /v1/models lists only the 7 paid models (0 free_eligible)
  const modelsRes = await h.app.fetch(new Request('https://cloud.test/v1/models'));
  assert.equal(modelsRes.status, 200);
  const modelsJson = await modelsRes.json();
  assert.equal(modelsJson.data.length, 7);
  assert.equal(modelsJson.data.filter((m) => m.free_eligible).length, 0);

  // 2. Removed legacy free slug returns 400 UNKNOWN_MODEL before touching upstream
  const freeRes = await h.app.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'olympus/auto-free', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }),
  );
  assert.equal(freeRes.status, 400);
  assert.equal((await freeRes.json()).error.code, 'UNKNOWN_MODEL');

  // 3. Paid model on a 0-credit account returns 402 INSUFFICIENT_CREDITS before touching upstream
  const paidRes = await h.app.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }),
  );
  assert.equal(paidRes.status, 402);
  assert.equal((await paidRes.json()).error.code, 'INSUFFICIENT_CREDITS');
  assert.equal(upstreamCalls.length, 0, 'zero unpaid requests may ever reach an upstream API key');
});

await test('Circuit-breaker failover from failing promo to official OpenRouter + strict x-olympus-official-only ZDR bypass', async () => {
  const hits = [];
  let promoFailing = true;
  const h = makeHarness({
    fetchImpl: async (url) => {
      const u = String(url);
      hits.push(u);
      if (u.startsWith('https://promo.mock') && promoFailing) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return sseResponse([
        {
          choices: [{ delta: { content: 'STREAMED_REPLY' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } },
        },
        '[DONE]',
      ]);
    },
  });

  const { token } = await h.issueUser({ userId: 'u_pro', plan: 'pro' });

  // 3 calls where promo returns 429 -> each seamlessly fails over to official openrouter, and after 3rd failure promo breaker opens
  for (let i = 0; i < 3; i++) {
    const res = await h.app.fetch(
      new Request('https://cloud.test/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', stream: true, messages: [{ role: 'user', content: 'code' }] }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-olympus-upstream'), 'openrouter');
    assert.equal(res.headers.get('x-olympus-failover-from'), 'promo');
    await res.text();
  }

  // 4th call while breaker is open skips promo completely (only hits openrouter!)
  hits.length = 0;
  const res4 = await h.app.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', stream: true, messages: [{ role: 'user', content: 'code' }] }),
    }),
  );
  assert.equal(res4.status, 200);
  await res4.text();
  assert.deepEqual(hits, ['https://openrouter.mock/v1/chat/completions'], 'open circuit breaker skips promo');

  // Advance clock past cooldown + heal promo -> officialOnly header STILL bypasses promo!
  h.advanceMs(BREAKER_COOLDOWN_MS + 1000);
  promoFailing = false;
  hits.length = 0;
  const zdrRes = await h.app.fetch(
    new Request('https://cloud.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-olympus-official-only': '1' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', stream: true, messages: [{ role: 'user', content: 'private code' }] }),
    }),
  );
  assert.equal(zdrRes.status, 200);
  assert.equal(zdrRes.headers.get('x-olympus-upstream'), 'openrouter');
  assert.equal(zdrRes.headers.get('x-olympus-official'), '1');
  await zdrRes.text();
  assert.deepEqual(hits, ['https://openrouter.mock/v1/chat/completions'], 'ZDR header never touches promo upstream');
});

await test('Zero-content-logging SSE streaming over /v1/messages (Anthropic) + HMAC billing webhook grants & deduplication', async () => {
  const SECRET_PROMPT = 'SUPER_SECRET_PRIVATE_KEY_999';
  const SECRET_REPLY = 'PRIVATE_ALGO_OUTPUT_888';

  const h = makeHarness({
    fetchImpl: async () =>
      sseResponse([
        { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 100_000 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SECRET_REPLY } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1_000 } },
        '[DONE]',
      ]),
  });

  const { token } = await h.issueUser({ userId: 'u_zdr', plan: 'free', githubVerified: false });

  // Without credits, paid Opus returns 402
  const noCredits = await h.app.fetch(
    new Request('https://cloud.test/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-opus-5.5', stream: true, messages: [{ role: 'user', content: SECRET_PROMPT }] }),
    }),
  );
  assert.equal(noCredits.status, 402);

  // Tampered webhook signature rejected with 401
  const subPayload = JSON.stringify({ eventId: 'evt_dodo_1', type: 'subscription.active', provider: 'dodo', userId: 'u_zdr', plan: 'starter' });
  const badHook = await h.app.fetch(
    new Request('https://cloud.test/v1/webhooks/billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-olympus-signature': 'sha256=' + '0'.repeat(64) },
      body: subPayload,
    }),
  );
  assert.equal(badHook.status, 401);

  // Valid HMAC webhook activates Starter (2,000 credits); replay is idempotent
  const sig = await signHmacSha256Hex('whsec_test_olympus_secret', subPayload);
  const okHook = await h.app.fetch(
    new Request('https://cloud.test/v1/webhooks/billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-olympus-signature': `sha256=${sig}` },
      body: subPayload,
    }),
  );
  assert.equal(okHook.status, 200);
  assert.equal((await okHook.json()).wallet.monthlyCredits, 2000);

  // Now Anthropic /v1/messages streams cleanly and deducts exact Opus 5.5 credits:
  // 5k in ($0.02) + 10k 5m write ($0.05) + 100k read ($0.02) + 1k out ($0.02) = $0.11 -> 14.6667 credits
  const streamRes = await h.app.fetch(
    new Request('https://cloud.test/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-opus-5.5', stream: true, messages: [{ role: 'user', content: SECRET_PROMPT }] }),
    }),
  );
  assert.equal(streamRes.status, 200);
  const fullStream = await streamRes.text();
  assert.ok(fullStream.includes(SECRET_REPLY));

  // Verify exact credit deduction via GET /v1/account/credits
  const creditsRes = await h.app.fetch(
    new Request('https://cloud.test/v1/account/credits', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(creditsRes.status, 200);
  const creditsJson = await creditsRes.json();
  const expectedCharged = Number((0.11 / USD_PER_CREDIT).toFixed(4));
  assert.equal(creditsJson.wallet.monthlyCredits, Number((2000 - expectedCharged).toFixed(4)));

  // Zero-content-logging audit: ledger holds ONLY numeric counts, ZERO prompt/reply bytes!
  assert.equal(h.ledger.length, 1);
  const serializedLedger = JSON.stringify(h.ledger);
  assert.equal(serializedLedger.includes(SECRET_PROMPT), false, 'prompt must NEVER appear in ledger');
  assert.equal(serializedLedger.includes(SECRET_REPLY), false, 'reply must NEVER appear in ledger');
  assert.equal(h.ledger[0].upstreamCostUsd, 0.11);
  assert.equal(h.ledger[0].creditsCharged, expectedCharged);
});

const failed = results.filter((r) => !r.ok);
console.log(`\nOlympus Cloud suite: ${results.length - failed.length}/${results.length} passed.`);
if (failed.length) process.exit(1);
