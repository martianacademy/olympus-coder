// Unit tests: limits for agents beyond Claude / Codex / Antigravity.
// - OpenCode: OpenRouter `/api/v1/key` + `/credits`, GitHub Copilot `copilot_internal/user`, OpenCode Zen (no source),
//   reading OpenCode's saved logins (v2 `opencode.db` credential table, v1 `auth.json`);
// - Olympus CLI: its local `/status` text and the proposed `/usage` limits contract;
// - agent kind detection, `formatLimitLine` with amounts, and the service storing the honest note.
// Fixtures marked REAL are trimmed copies of replies seen on 2026-11-18; the Copilot quota_snapshots fixture follows
// the shape community tools document for this undocumented endpoint (not seen live: the account here has no plan).
// Files: src/main/providerLimits.ts, src/main/limitProbe.ts, src/main/limitsService.ts, src/shared/quota.ts.
// Run: node tests/providerLimits.unit.mjs
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const pl = await import(pathToFileURL(`${APP}/src/main/providerLimits.ts`).href);
const probe = await import(pathToFileURL(`${APP}/src/main/limitProbe.ts`).href);
const svc = await import(pathToFileURL(`${APP}/src/main/limitsService.ts`).href);
const quota = await import(pathToFileURL(`${APP}/src/shared/quota.ts`).href);

let n = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    n++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${e?.stack ?? e}`);
  }
}

const NOW = Date.UTC(2026, 10, 18, 15, 30); // 2026-11-18 15:30 UTC

// REAL: OpenRouter GET /api/v1/key (ids and label removed).
const OR_KEY = {
  data: {
    limit: 10,
    limit_reset: null,
    limit_remaining: 8.609895165,
    usage: 1.390104835,
    usage_daily: 0,
    usage_weekly: 1.390104835,
    usage_monthly: 1.390104835,
    is_free_tier: false,
    free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 },
    rate_limit: { requests: -1, interval: '10s', note: 'This field is deprecated and safe to ignore.' },
  },
};
// REAL: OpenRouter GET /api/v1/credits.
const OR_CREDITS = { data: { total_credits: 155, total_usage: 145.493593927 } };
// REAL: copilot_internal/user for a Copilot account without an active plan (personal fields removed).
const COPILOT_LOCKED = { access_type_sku: 'billing_locked', chat_enabled: false, copilot_plan: 'individual', can_upgrade_plan: false };
// Community-documented shape (not seen live).
const COPILOT_PRO = {
  copilot_plan: 'individual',
  quota_reset_date: '2026-12-01',
  quota_snapshots: {
    chat: { entitlement: 0, remaining: 0, unlimited: true, percent_remaining: 100 },
    premium_interactions: { entitlement: 300, remaining: 189, percent_remaining: 63, unlimited: false, overage_permitted: false },
  },
};
// REAL: `oly acp` `/status` reply.
const OLY_STATUS = [
  '**Olympus Native Agent** (`v0.1.0`)',
  '- **Gateway**: LM Studio (local) (`http://127.0.0.1:1234/v1`) · provider id `lmstudio`',
  '- **Model**: `qwen/qwen3.8-27b` (context window: 65,536 tokens)',
  '- **Mode**: `code` · **Reasoning**: `medium`',
  '- **Session Usage**: 0 tokens',
  '- **Connected MCP Tools**: 0',
].join('\n');

// ---------------------------------------------------------------- OpenRouter
await test('OpenRouter: key limit in USD and free-model requests of the UTC day, from the real /key reply', () => {
  const l = pl.parseOpenRouterKey(OR_KEY, NOW);
  assert.equal(l.length, 2);
  const key = l.find((x) => x.window === 'openrouter_key');
  assert.equal(key.label, 'OpenRouter key limit');
  assert.ok(Math.abs(key.utilization - 0.139) < 0.001);
  assert.equal(key.resetsAt, undefined, 'limit_reset null: never resets');
  assert.deepEqual(key.amount, { used: 1.390105, limit: 10, unit: 'usd' });
  const free = l.find((x) => x.window === 'openrouter_free_daily');
  assert.equal(free.utilization, 0);
  assert.equal(free.resetsAt, Date.UTC(2026, 10, 19), 'next 00:00 UTC');
  assert.equal(quota.formatLimitLine(key), 'OpenRouter key limit: 14% used ($1.39 of $10)');
});

await test('OpenRouter: limit_reset monthly / weekly / daily give the documented UTC reset; no limit = no window', () => {
  const m = pl.parseOpenRouterKey({ data: { limit: 20, limit_remaining: 5, limit_reset: 'monthly' } }, NOW)[0];
  assert.equal(m.label, 'OpenRouter key limit · monthly');
  assert.equal(m.resetsAt, Date.UTC(2026, 11, 1));
  assert.equal(pl.parseOpenRouterKey({ data: { limit: 20, limit_remaining: 5, limit_reset: 'weekly' } }, NOW)[0].resetsAt, Date.UTC(2026, 10, 23), 'next Monday');
  assert.equal(pl.parseOpenRouterKey({ data: { limit: 20, limit_remaining: 5, limit_reset: 'daily' } }, NOW)[0].resetsAt, Date.UTC(2026, 10, 19));
  assert.deepEqual(pl.parseOpenRouterKey({ data: { limit: null, limit_remaining: null } }, NOW), []);
});

await test('OpenRouter: account credits from the real /credits reply', () => {
  const c = pl.parseOpenRouterCredits(OR_CREDITS);
  assert.equal(c.label, 'OpenRouter credits');
  assert.ok(Math.abs(c.utilization - 0.9387) < 0.001);
  assert.equal(quota.formatLimitLine(c), 'OpenRouter credits: 94% used ($145.49 of $155)');
  assert.equal(pl.parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 0 } }), undefined);
});

// ---------------------------------------------------------------- Copilot
await test('Copilot: a billing-locked account (real reply) gives a note, no fake window', () => {
  const r = pl.parseCopilotUser(COPILOT_LOCKED);
  assert.deepEqual(r.limits, []);
  assert.equal(r.note, 'GitHub Copilot · billing locked, no premium requests');
});

await test('Copilot: premium_interactions → monthly premium requests with the reset date', () => {
  const r = pl.parseCopilotUser(COPILOT_PRO);
  assert.equal(r.limits.length, 1);
  const p = r.limits[0];
  assert.equal(p.label, 'Copilot premium requests · monthly');
  assert.equal(p.utilization, 111 / 300);
  assert.deepEqual(p.amount, { used: 111, limit: 300, unit: 'requests' });
  assert.equal(p.resetsAt, Date.parse('2026-12-01'));
  assert.equal(pl.parseCopilotUser({ quota_snapshots: { premium_interactions: { unlimited: true } } }).note, 'GitHub Copilot premium requests · unlimited');
  // In the views: 37% used, "111 of 300 requests", and the date for a reset more than a week ahead.
  const line = quota.formatLimitLine({ ...p, resetsAt: Date.now() + 13 * 86_400_000 });
  assert.match(line, /^Copilot premium requests · monthly: 37% used \(111 of 300 requests, resets [A-Z][a-z]{2} \d{1,2}\)$/);
});

// ---------------------------------------------------------------- OpenCode logins + combined read
await test('OpenCode: saved logins from the v2 credential table (active rows only) and v1 auth.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-creds-'));
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(join(dir, 'opencode.db'));
    db.exec('CREATE TABLE credential (id text primary key, integration_id text, label text not null, value text not null, connector_id text, method_id text, active integer, time_created integer not null, time_updated integer not null)');
    const ins = db.prepare('INSERT INTO credential VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('a', 'openrouter', 'OpenRouter', JSON.stringify({ type: 'key', key: 'sk-or-test' }), null, null, 1, 1, 2);
    ins.run('b', 'opencode', 'Personal', JSON.stringify({ type: 'oauth', refresh: 'r-old' }), null, null, 0, 1, 3);
    ins.run('c', 'opencode', 'Personal', JSON.stringify({ type: 'oauth', refresh: 'r-new' }), null, null, 1, 1, 1);
    db.close();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'gho_x', access: 'gho_y' }, openrouter: { type: 'api', key: 'ignored-db-wins' } }));
    const creds = pl.readOpenCodeCredentials(dir);
    const by = Object.fromEntries(creds.map((c) => [c.integration, c]));
    assert.equal(by.openrouter.key, 'sk-or-test');
    assert.equal(by.opencode.refresh, 'r-new', 'inactive login skipped');
    assert.equal(by['github-copilot'].refresh, 'gho_x');
    assert.deepEqual(pl.readOpenCodeCredentials(join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('OpenCode: one read over every login (fake HTTP), keys sent only to their own provider', async () => {
  const calls = [];
  const fetch = async (url, headers) => {
    calls.push([url, headers.Authorization]);
    if (url.endsWith('/api/v1/key')) return { status: 200, body: OR_KEY };
    if (url.endsWith('/api/v1/credits')) return { status: 200, body: OR_CREDITS };
    if (url.includes('copilot_internal')) return { status: 200, body: COPILOT_LOCKED };
    return { status: 404, body: null };
  };
  const creds = [
    { integration: 'github-copilot', refresh: 'gho_x' },
    { integration: 'opencode', refresh: 'r' },
    { integration: 'openrouter', key: 'sk-or-test' },
  ];
  const r = await pl.readOpenCodeLimits(creds, { fetch, now: NOW });
  assert.deepEqual(r.limits.map((l) => l.window), ['openrouter_key', 'openrouter_free_daily', 'openrouter_credits']);
  assert.equal(r.note, 'GitHub Copilot · billing locked, no premium requests; OpenCode Zen · no quota reported');
  assert.equal(r.plan, 'GitHub Copilot · OpenCode Zen · OpenRouter');
  for (const [url, auth] of calls) {
    if (url.startsWith('https://openrouter.ai/')) assert.equal(auth, 'Bearer sk-or-test');
    else {
      assert.equal(url, 'https://api.github.com/copilot_internal/user');
      assert.equal(auth, 'token gho_x');
    }
  }
  assert.equal(calls.length, 3);
});

await test('OpenCode: one provider failing keeps the others; all failing throws (service backs off)', async () => {
  const creds = [{ integration: 'github-copilot', refresh: 'g' }, { integration: 'openrouter', key: 'k' }];
  const half = await pl.readOpenCodeLimits(creds, { now: NOW, fetch: async (url) => (url.includes('copilot') ? { status: 500, body: null } : { status: 200, body: url.endsWith('/key') ? OR_KEY : OR_CREDITS }) });
  assert.equal(half.limits.length, 3);
  assert.match(half.note, /GitHub Copilot · read failed/);
  await assert.rejects(pl.readOpenCodeLimits(creds, { now: NOW, fetch: async () => { throw new Error('offline'); } }), /offline/);
  const none = await pl.readOpenCodeLimits([], { now: NOW, fetch: async () => assert.fail('no call') });
  assert.equal(none.note, 'No provider login saved in OpenCode');
  const refused = await pl.readOpenCodeLimits([{ integration: 'openrouter', key: 'bad' }], { now: NOW, fetch: async () => ({ status: 401, body: null }) });
  assert.equal(refused.note, 'OpenRouter · saved key was refused');
});

await test('Quota: a used-up provider limit blocks only that provider\'s models when the agent has other logins', async () => {
  const creds = [{ integration: 'opencode', refresh: 'r' }, { integration: 'openrouter', key: 'k' }];
  const spent = { data: { total_credits: 10, total_usage: 10 } };
  const r = await pl.readOpenCodeLimits(creds, { now: NOW, fetch: async (url) => ({ status: 200, body: url.endsWith('/key') ? { data: {} } : spent }) });
  assert.ok(r.limits.every((l) => l.partial && l.group === 'OpenRouter'));
  const st = { id: 'opencode', state: 'ready', authMethods: [], hasApiKey: false, canLogout: false, limits: r.limits };
  assert.equal(quota.quotaState(st).out, false, 'Zen free models still work');
  assert.equal(quota.quotaState(st, 'opencode/glm-5.3-flash-free').out, false);
  assert.equal(quota.quotaState(st, 'openrouter/~deepseek/deepseek-v4-flash-latest').out, true);
  const only = await pl.readOpenCodeLimits([creds[1]], { now: NOW, fetch: async (url) => ({ status: 200, body: url.endsWith('/key') ? { data: {} } : spent }) });
  assert.equal(quota.quotaState({ ...st, limits: only.limits }).out, true, 'the only provider used up: the agent is out');
});

// ---------------------------------------------------------------- Olympus CLI
await test('Olympus CLI: real /status with LM Studio → "local model, no limits", plan = gateway', () => {
  const r = probe.parseOlympusStatus(OLY_STATUS, NOW);
  assert.deepEqual(r.limits, []);
  assert.equal(r.plan, 'LM Studio (local)');
  assert.equal(r.note, 'LM Studio · local model, no limits');
  const pr = probe.parseProbeReply('status', OLY_STATUS, NOW, 'olympus');
  assert.equal(pr.empty, true);
  assert.equal(pr.note, 'LM Studio · local model, no limits');
});

await test('Olympus CLI: a remote API-key gateway without limit lines says pay per use, no quota reported', () => {
  const r = probe.parseOlympusStatus('- **Gateway**: OpenRouter (`https://openrouter.ai/api/v1`) · provider id `openrouter`', NOW);
  assert.equal(r.note, 'OpenRouter · API key, pay per use · no quota reported');
});

await test('Olympus CLI: the proposed /usage contract (Claude-style lines, amounts, **Limits:**) parses', () => {
  const md = [
    '> Olympus OpenRouter usage',
    '- **Gateway**: OpenRouter (`https://openrouter.ai/api/v1`) · provider id `openrouter`',
    '**OpenRouter key limit · monthly** — **14%** · Resets Dec 1, 5:30 AM GMT+5:30 · $1.39 of $10',
    '**OpenRouter credits** — **94%** · $145.49 of $155',
    '**5-hour limit** — **37%** · Resets Nov 18, 11:00 PM GMT+5:30',
  ].join('\n');
  const r = probe.parseOlympusStatus(md, NOW);
  assert.equal(r.limits.length, 3);
  const [k, c, five] = r.limits;
  assert.equal(k.label, 'OpenRouter key limit · monthly');
  assert.deepEqual(k.amount, { used: 1.39, limit: 10, unit: 'usd' });
  assert.equal(k.resetsAt, Date.UTC(2026, 11, 1, 0, 0));
  assert.equal(c.resetsAt, undefined);
  assert.equal(c.utilization, 0.94);
  assert.equal(five.window, 'five_hour');
  assert.equal(five.resetsAt, Date.UTC(2026, 10, 18, 17, 30));
  assert.equal(r.note, undefined, 'limit lines: no fallback note');
  assert.equal(probe.parseOlympusStatus('**Limits:** none (local model)\n- **Gateway**: Ollama (`http://localhost:11434/v1`)', NOW).note, 'none (local model)');
});

await test('Olympus CLI: hidden probe sends /status, parses the CLI format and deletes the session', async () => {
  const calls = [];
  const sessions = new probe.ProbeSessions();
  const rpc = {
    async request(method, params) {
      calls.push(method);
      if (method === 'session/new') return { sessionId: 's1' };
      if (method === 'session/prompt') {
        assert.deepEqual(params.prompt, [{ type: 'text', text: '/status' }]);
        sessions.offer('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: OLY_STATUS } });
        return { stopReason: 'end_turn' };
      }
      return {};
    },
  };
  const r = await probe.runProbe(rpc, sessions, { agentId: 'olympus', cwd: '/tmp', command: probe.probeCommandFor('olympus'), kind: 'olympus', canClose: true, deleteAfter: true, timeoutMs: 5000 });
  assert.deepEqual(calls, ['session/new', 'session/prompt', 'session/delete']);
  assert.equal(r.note, 'LM Studio · local model, no limits');
});

// ---------------------------------------------------------------- kinds and commands
await test('Kinds: built-ins by id, custom agents by the binary they run', () => {
  assert.equal(probe.limitsKindOf({ id: 'olympus' }), 'olympus');
  assert.equal(probe.limitsKindOf({ id: 'olympus-cli', command: 'oly', args: [] }), 'olympus');
  assert.equal(probe.limitsKindOf({ id: 'my-oly', command: '/Users/x/.local/bin/oly', args: ['acp'] }), 'olympus');
  assert.equal(probe.limitsKindOf({ id: 'opencode', command: '/Users/x/.olympus/agents/opencode/2.3.0/opencode', args: ['acp'] }), 'opencode');
  assert.equal(probe.limitsKindOf({ id: 'opencode-v2', command: '/x/opencode-v2/2.3.0/opencode', args: ['acp'], registryId: 'opencode-v2' }), 'opencode');
  assert.equal(probe.limitsKindOf({ id: 'goose', command: 'goose', args: ['acp'] }), undefined);
  assert.equal(probe.probeCommandFor('olympus'), 'status');
  assert.equal(probe.probeCommandFor('olympus-cli', undefined, 'olympus'), 'status');
  assert.equal(probe.probeCommandFor('olympus', ['status', 'usage', 'models']), 'usage', 'the contract command wins once advertised');
  assert.equal(probe.probeCommandFor('opencode', ['init', 'review', 'goal', 'compact'], 'opencode'), undefined, 'OpenCode has no limits command');
  assert.equal(probe.probeCommandFor('claude'), 'usage');
  assert.equal(probe.probeCommandFor('codex'), 'status');
});

// ---------------------------------------------------------------- service: http reader + note
await test('Service: an http read stores limits, plan and the note; never needs the agent running or idle', async () => {
  const a = { id: 'opencode', state: 'ready', installed: true, running: false, busy: true };
  let reads = 0;
  const host = {
    agents: () => [a],
    reader: () => 'http',
    mayStart: () => false,
    read: async () => {
      reads++;
      return { limits: pl.parseOpenRouterKey(OR_KEY, NOW), note: 'OpenCode Zen · no quota reported', plan: 'OpenCode Zen · OpenRouter' };
    },
    patch: (_id, p) => Object.assign(a, p),
  };
  const s = new svc.LimitsService();
  s.setHost(host);
  await s.refresh('opencode', { reason: 'interval' });
  assert.equal(reads, 1);
  assert.equal(a.limits.length, 2);
  assert.equal(a.limitsNote, 'OpenCode Zen · no quota reported');
  assert.equal(a.plan, 'OpenCode Zen · OpenRouter');
  assert.equal(a.limitsReadable, true);
  s.turnEnded('opencode');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads, 2, 'a finished turn re-reads provider-backed limits');
  s.stop();
});

await test('Service: an empty read with a note keeps old numbers, clears an old note when the next read has none', async () => {
  const a = { id: 'olympus', state: 'ready', installed: true, running: true, busy: false, limitsNote: 'old' };
  let next = { limits: [], empty: true, note: 'LM Studio · local model, no limits' };
  const host = { agents: () => [a], reader: () => 'probe', mayStart: () => true, read: async () => next, patch: (_id, p) => Object.assign(a, p) };
  const s = new svc.LimitsService();
  s.setHost(host);
  await s.refresh('olympus', { reason: 'x', force: true });
  assert.equal(a.limitsNote, 'LM Studio · local model, no limits');
  next = { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 0.2 }] };
  await s.refresh('olympus', { reason: 'x', force: true });
  assert.equal(a.limitsNote, undefined);
  assert.equal(a.limits[0].utilization, 0.2);
  s.stop();
});

console.log(`\n${n} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
