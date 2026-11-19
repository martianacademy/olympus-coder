import assert from 'node:assert/strict';
import { createCloudApp } from '../dist/app.js';
import { BudgetCore } from '../dist/budgetCore.js';
import { STARTER_GIFT_CREDITS } from '../dist/pricing.js';
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

function makeKv() {
  const map = new Map();
  return {
    async get(k) { const v = map.get(k); return v === undefined ? undefined : structuredClone(v); },
    async put(k, v) { map.set(k, structuredClone(v)); },
  };
}

function makePortalHarness({ ghCreatedAt = '2022-01-10T00:00:00Z', ghEmail = null } = {}) {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const usersByGithub = new Map();
  const usersByHash = new Map();
  const wallets = new Map();

  const metadata = {
    async lookupToken(h) { return usersByHash.get(h) ?? null; },
    async upsertOAuthUser(input, tokenHash) {
      let existing = usersByGithub.get(input.githubId);
      const isNew = !existing;
      if (!existing) {
        existing = {
          userId: `usr_gh_${input.githubId}`,
          email: input.email,
          plan: 'free',
          officialOnly: false,
          githubVerified: true,
        };
        usersByGithub.set(input.githubId, existing);
      }
      usersByHash.set(tokenHash, { ...existing });
      return { user: { ...existing }, isNewUser: isNew };
    },
    async updateUserPlan() {},
    async recordUsage() {},
  };

  const getWallet = (uid) => {
    let w = wallets.get(uid);
    if (!w) { w = new WalletCore(makeKv(), uid); wallets.set(uid, w); }
    return w;
  };

  const app = createCloudApp({
    metadata,
    getWallet,
    budget: new BudgetCore(makeKv()),
    upstreams: {},
    globalFreeDailyUsdCap: 10,
    oauth: {
      githubClientId: 'gh_client_123',
      githubClientSecret: 'gh_secret_456',
      oauthStateSecret: 'state_hmac_secret_789',
    },
    checkoutLinks: {
      starterUrl: 'https://checkout.dodopayments.com/buy/pdt_starter',
      proUrl: 'https://checkout.dodopayments.com/buy/pdt_pro',
      maxUrl: 'https://checkout.dodopayments.com/buy/pdt_max',
      topup10Url: 'https://checkout.dodopayments.com/buy/pdt_topup10',
    },
    nowMs: () => now,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/login/oauth/access_token')) {
        return Response.json({ access_token: 'gho_mock_access_token' });
      }
      if (u.endsWith('/user')) {
        return Response.json({ id: 424242, login: 'suru', email: ghEmail, created_at: ghCreatedAt });
      }
      if (u.endsWith('/user/emails')) {
        return Response.json([{ email: 'suru.martian@gmail.com', primary: true, verified: true }]);
      }
      throw new Error(`Unexpected OAuth upstream URL: ${u}`);
    },
  });

  return { app, getWallet };
}

await test('Landing page GET /cloud renders paid-only zero-logging developer portal with BYO/Ollama note and no-referrer header', async () => {
  const { app } = makePortalHarness();
  const res = await app.fetch(new Request('https://api.olympuscoder.app/cloud'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.match(html, /Olympus Cloud/);
  assert.match(html, /Zero prompt &amp; code logging/);
  assert.match(html, /\$20/);
  assert.match(html, /\$60/);
  assert.match(html, /\$100/);
  assert.match(html, /\$10/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /Local Ollama/);
  assert.doesNotMatch(html, /free requests \/ day/i);
  assert.doesNotMatch(html, /starter gift/i);
});

await test('GitHub OAuth CLI loopback flow: validates cli_port, enforces CSRF nonce cookie, starts at 0 credits (paid-only), and redirects to 127.0.0.1', async () => {
  const { app, getWallet } = makePortalHarness({ ghCreatedAt: '2021-05-01T00:00:00Z', ghEmail: null });

  // Reject out-of-range or malicious cli_port
  const badPort = await app.fetch(new Request('https://api.olympuscoder.app/v1/auth/github/start?cli_port=80'));
  assert.equal(badPort.status, 400);

  // Start valid CLI OAuth flow
  const startRes = await app.fetch(
    new Request('https://api.olympuscoder.app/v1/auth/github/start?cli_port=54321&cli_state=cli_nonce_abcdef1234567890'),
  );
  assert.equal(startRes.status, 302);
  const ghRedirect = new URL(startRes.headers.get('location'));
  assert.equal(ghRedirect.origin, 'https://github.com');
  const stateParam = ghRedirect.searchParams.get('state');
  const setCookie = startRes.headers.get('set-cookie') ?? '';
  const cookiePair = setCookie.split(';')[0];
  assert.match(cookiePair, /^oly_oauth_nonce=[a-f0-9]{32}$/);

  // Callback WITHOUT matching cookie fails CSRF check
  const csrfFail = await app.fetch(
    new Request(`https://api.olympuscoder.app/v1/auth/github/callback?code=gh_code_1&state=${encodeURIComponent(stateParam)}`),
  );
  assert.equal(csrfFail.status, 400);

  // Callback WITH matching cookie succeeds, falls back to /user/emails, issues token with 0 credits, and redirects strictly to 127.0.0.1:54321
  const cbRes = await app.fetch(
    new Request(`https://api.olympuscoder.app/v1/auth/github/callback?code=gh_code_1&state=${encodeURIComponent(stateParam)}`, {
      headers: { Cookie: cookiePair },
    }),
  );
  assert.equal(cbRes.status, 302);
  const localRedirect = new URL(cbRes.headers.get('location'));
  assert.equal(localRedirect.origin, 'http://127.0.0.1:54321');
  assert.equal(localRedirect.pathname, '/callback');
  assert.equal(localRedirect.searchParams.get('state'), 'cli_nonce_abcdef1234567890');
  assert.equal(localRedirect.searchParams.get('email'), 'suru.martian@gmail.com');
  const issuedToken = localRedirect.searchParams.get('token');
  assert.match(issuedToken, /^oly_live_[a-f0-9]{48}$/);

  const snap = await getWallet('usr_gh_424242').snapshot(Date.parse('2026-11-19T12:00:00Z'));
  assert.equal(STARTER_GIFT_CREDITS, 0);
  assert.equal(snap.starterGiftCredits, 0);
  assert.equal(snap.availableCredits, 0);
  assert.equal(snap.freeDailyLimit, 0);
});

await test('Web portal OAuth sign-in starts at 0 credits and routes checkout with metadata[userId] + prefilled_email', async () => {
  const { app } = makePortalHarness({ ghCreatedAt: '2026-11-18T00:00:00Z', ghEmail: 'newbot@example.com' });

  const startRes = await app.fetch(new Request('https://api.olympuscoder.app/v1/auth/github/start'));
  const stateParam = new URL(startRes.headers.get('location')).searchParams.get('state');
  const cookiePair = (startRes.headers.get('set-cookie') ?? '').split(';')[0];

  const cbRes = await app.fetch(
    new Request(`https://api.olympuscoder.app/v1/auth/github/callback?code=gh_code_new&state=${encodeURIComponent(stateParam)}`, {
      headers: { Cookie: cookiePair },
    }),
  );
  assert.equal(cbRes.status, 200);
  const html = await cbRes.text();
  const tokenMatch = /oly_live_[a-f0-9]{48}/.exec(html);
  assert.ok(tokenMatch, 'web portal renders one-time token');
  const token = tokenMatch[0];

  const creditsRes = await app.fetch(
    new Request('https://api.olympuscoder.app/v1/account/credits', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const creditsJson = await creditsRes.json();
  assert.equal(creditsJson.wallet.starterGiftCredits, 0, '<30d GitHub account receives 0 starter gift');

  // POST /v1/billing/checkout binds metadata[userId] and prefilled_email with 303 + no-referrer
  const formBody = new URLSearchParams({ target: 'pro', token }).toString();
  const checkoutRes = await app.fetch(
    new Request('https://api.olympuscoder.app/v1/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    }),
  );
  assert.equal(checkoutRes.status, 303);
  assert.equal(checkoutRes.headers.get('referrer-policy'), 'no-referrer');
  const dodoUrl = new URL(checkoutRes.headers.get('location'));
  assert.equal(dodoUrl.origin, 'https://checkout.dodopayments.com');
  assert.equal(dodoUrl.searchParams.get('metadata[userId]'), 'usr_gh_424242');
  assert.equal(dodoUrl.searchParams.get('prefilled_email'), 'newbot@example.com');
});

const failed = results.filter((r) => !r.ok);
console.log(`\nOlympus Cloud OAuth & Portal suite: ${results.length - failed.length}/${results.length} passed.`);
if (failed.length) process.exit(1);
