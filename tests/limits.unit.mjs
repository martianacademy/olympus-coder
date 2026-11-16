// Unit tests: plan limits kept fresh without a chat.
// - parsing the real adapters' output: Claude `formatUsageResponse` (claude-agent-acp/dist/usage-markdown.js) and
//   Codex's `/status` formatter methods (lifted verbatim from codex-acp/dist/index.js), in several time zones;
// - expiry (`liveLimits`, `quotaState`, `formatLimitLine`);
// - the hidden probe session (`runProbe` + `ProbeSessions`) against a fake connection;
// - scheduling (`LimitsService`): reset timer, live-turn skip, backoff, dedupe, max age, test filter.
// Files: src/main/limitProbe.ts, src/main/limitsService.ts, src/shared/quota.ts.
// Run: node tests/limits.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const probe = await import(pathToFileURL(`${APP}/src/main/limitProbe.ts`).href);
const svc = await import(pathToFileURL(`${APP}/src/main/limitsService.ts`).href);
const quota = await import(pathToFileURL(`${APP}/src/shared/quota.ts`).href);
const claudeMd = await import(pathToFileURL(`${APP}/node_modules/@agentclientprotocol/claude-agent-acp/dist/usage-markdown.js`).href);

/** Codex's own `/status` limit formatter: the class methods copied out of the bundle, unchanged. */
function codexFormatter() {
  const src = readFileSync(`${APP}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`, 'utf8');
  const start = src.indexOf('  formatRateLimitLines(rateLimits) {');
  const end = src.indexOf('  formatTokenCount(count) {', start);
  assert.ok(start > 0 && end > start, 'codex-acp formatter methods found');
  const F = new Function(`return class F {\n${src.slice(start, end)}\n}`)();
  return new F();
}

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
const minute = (t) => Math.floor(t / 60_000);

// ---------------------------------------------------------------- time-zone child: parse in this process's TZ
if (process.env.LIMITS_TZ_CHILD) {
  const now = Date.now();
  const five = new Date(now + 2 * 3600_000 + 17 * 60_000);
  const week = new Date(now + 4 * 86_400_000 + 5 * 3600_000);
  const usage = {
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, model_usage: {} },
    subscription_type: 'Max',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 37, resets_at: five.toISOString() }, seven_day: { utilization: 81.5, resets_at: week.toISOString() } },
    behaviors: null,
  };
  const md = claudeMd.formatUsageResponse(claudeMd.parseUsageResponse(usage));
  const c = probe.parseClaudeUsage(md, now);
  const f = codexFormatter();
  const map = new Map([['codex', { limitId: 'codex', limitName: 'codex', snapshot: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Math.floor(five.getTime() / 1000) }, secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: Math.floor(week.getTime() / 1000) } } }]]);
  const x = probe.parseCodexStatus(f.formatRateLimitLines(map).join('  \n'), now);
  console.log(JSON.stringify({ tz: process.env.TZ, md: md.split('\n').filter((l) => l.startsWith('**')), c, x, five: five.getTime(), week: week.getTime() }));
  process.exit(0);
}

// ---------------------------------------------------------------- Claude /usage
await test('Claude: the adapter\'s structured /usage markdown parses to windows, percents and resets', () => {
  const now = Date.parse('2026-11-16T10:00:00Z');
  const usage = {
    session: { total_cost_usd: 1.2, total_api_duration_ms: 1000, total_duration_ms: 5000, model_usage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
    subscription_type: 'Max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 100, resets_at: '2026-11-16T11:30:00Z' },
      seven_day: { utilization: 42, resets_at: '2026-11-20T04:00:00Z' },
      model_scoped: [{ display_name: 'Opus', utilization: 12.5, resets_at: '2026-11-20T04:00:00Z' }, { display_name: 'Fable', utilization: 3, resets_at: null }],
    },
    behaviors: null,
  };
  const md = claudeMd.formatUsageResponse(claudeMd.parseUsageResponse(usage));
  const r = probe.parseClaudeUsage(md, now);
  assert.equal(r.plan, 'Claude Max');
  assert.deepEqual(r.limits.map((l) => [l.window, l.label, l.utilization]), [
    ['five_hour', '5-hour limit', 1],
    ['seven_day', 'Weekly limit', 0.42],
    ['seven_day_opus', 'Weekly (Opus)', 0.125],
    ['seven_day_fable', 'Weekly (Fable)', 0.03],
  ]);
  assert.equal(minute(r.limits[0].resetsAt), minute(Date.parse('2026-11-16T11:30:00Z')));
  assert.equal(minute(r.limits[1].resetsAt), minute(Date.parse('2026-11-20T04:00:00Z')));
  assert.equal(r.limits[3].resetsAt, undefined);
  const pr = probe.parseProbeReply('usage', md, now);
  assert.equal(pr.command, 'usage');
  assert.equal(pr.empty, undefined);
});

await test('Claude: the exact live /usage reply (2026-11-16, Claude Code 2.1.312) parses', () => {
  const now = Date.parse('2026-11-16T06:20:00Z');
  const live = ['## Usage', '', '> Claude max subscription usage', '', '### Limits', '', '**5-hour limit** — **15%** · Resets Nov 16, 4:29 PM GMT+5:30', '', '`███░░░░░░░░░░░░░░░░░`', '', '**Weekly · all models** — **27%** · Resets Nov 22, 8:29 PM GMT+5:30', '', '`█████░░░░░░░░░░░░░░░`', '', '**Weekly · Fable** — **5%** · Resets Nov 22, 8:29 PM GMT+5:30', '', '---', '', '### This session', '', '| Cost | API time | Active |', '|:--|:--|:--|', '| $0.00 | 0s | 8s |', '', '**Last 24h** · 3222 requests · 28 sessions', '', '- **67%** Start fresh when you switch tasks · run /clear', '| olympus | `█░░░░░░░░░░░░░░░░░░░` 6% |'].join('\n');
  const r = probe.parseClaudeUsage(live, now);
  assert.equal(r.plan, 'Claude Max');
  assert.deepEqual(r.limits.map((l) => [l.window, l.utilization, new Date(l.resetsAt).toISOString()]), [
    ['five_hour', 0.15, '2026-11-16T10:59:00.000Z'],
    ['seven_day', 0.27, '2026-11-22T14:59:00.000Z'],
    ['seven_day_fable', 0.05, '2026-11-22T14:59:00.000Z'],
  ]);
});

await test('Codex: the exact live /status reply (2026-11-16, codex-acp 2.6.0) parses', () => {
  const now = Date.parse('2026-11-16T06:20:00Z');
  const live = ['**Model:** gpt-6-astra[high]  ', '**Directory:** /tmp/x  ', '**Approval:** on-request  ', '**Sandbox:** workspace-write  ', '**Account:** ChatGPT free (someone@example.com)  ', '**Session:** `01a1e305`  ', '  ', '**Token usage:** data not available yet  ', '**Context window:** data not available yet  ', '**codex Weekly limit:** 0% left (resets 22:44 on Nov 27)'].join('\n');
  const r = probe.parseProbeReply('status', live, now);
  assert.equal(r.plan, 'ChatGPT Free');
  assert.equal(r.limits.length, 1);
  assert.equal(r.limits[0].label, 'Weekly limit');
  assert.equal(r.limits[0].utilization, 1);
  const d = new Date(r.limits[0].resetsAt);
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [10, 27, 22, 44]);
});

await test('Claude: an API-key login (no limits) is "empty", not an error; fallback text lines still parse', () => {
  const md = claudeMd.formatUsageResponse(
    claudeMd.parseUsageResponse({ session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, model_usage: {} }, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null }),
  );
  assert.deepEqual(probe.parseProbeReply('usage', md).limits, []);
  assert.equal(probe.parseProbeReply('usage', md).empty, true);
  const raw = probe.parseClaudeUsage('Current session: 23% used\nCurrent week (all models): 61% used');
  assert.deepEqual(raw.limits.map((l) => [l.window, l.utilization]), [
    ['five_hour', 0.23],
    ['seven_day', 0.61],
  ]);
});

await test('Claude reset text: Intl en forms incl. narrow no-break space, GMT offsets, year roll-over', () => {
  const now = Date.parse('2026-12-31T20:00:00Z');
  assert.equal(probe.parseClaudeReset('Jan 1, 2:30 AM GMT+5:30', now), Date.parse('2026-12-31T21:00:00Z'));
  assert.equal(probe.parseClaudeReset('Jan 3, 9:05 PM UTC', now), Date.parse('2027-01-03T21:05:00Z'));
  assert.equal(probe.parseClaudeReset('Dec 31, 11:00 PM GMT-3', now), Date.parse('2027-01-01T02:00:00Z'));
  assert.equal(probe.parseClaudeReset('nothing here', now), undefined);
});

// ---------------------------------------------------------------- Codex /status
await test('Codex: its own /status lines (5h, weekly, today / other day, spend limit) parse; other limit names are left out', () => {
  const f = codexFormatter();
  const now = Date.now();
  const inTwoHours = now + 2 * 3600_000;
  const inThreeDays = now + 3 * 86_400_000;
  const map = new Map([
    ['codex', { limitId: 'codex', limitName: 'codex', snapshot: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(inTwoHours / 1000) }, secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: Math.floor(inThreeDays / 1000) }, credits: { unlimited: false, balance: '12' } } }],
    ['spark', { limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark', snapshot: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(inTwoHours / 1000) } } }],
  ]);
  const text = ['**Model:** gpt-5.5', '**Account:** ChatGPT pro (me@example.com)', '**Context window:** 12% used (1K used / 200K)', ...f.formatRateLimitLines(map)].join('  \n');
  const r = probe.parseCodexStatus(text, now);
  assert.equal(r.plan, 'ChatGPT Pro');
  assert.deepEqual(r.limits.map((l) => [l.window, l.label, l.utilization]), [
    ['codex_5h', '5-hour limit', 1],
    ['codex_weekly', 'Weekly limit', 0.37],
  ]);
  assert.equal(minute(r.limits[0].resetsAt), minute(inTwoHours));
  assert.equal(minute(r.limits[1].resetsAt), minute(inThreeDays));
});

await test('Codex: "data not available yet" and "not logged in" are reported as such', () => {
  const f = codexFormatter();
  const none = probe.parseProbeReply('status', ['**Account:** ChatGPT plus (a@b.c)', ...f.formatRateLimitLines(new Map())].join('  \n'));
  assert.equal(none.empty, true);
  assert.equal(none.plan, 'ChatGPT Plus');
  const out = probe.parseProbeReply('status', '**Account:** not logged in  \n**Limits:** data not available yet');
  assert.equal(out.loggedOut, true);
});

await test('Reset times parse the same in other time zones (adapter and app share the machine\'s zone)', () => {
  for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'UTC', 'Europe/London', 'Australia/Adelaide']) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: tz, LIMITS_TZ_CHILD: '1' }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.c.limits.length, 2, `${tz}: ${JSON.stringify(r.md)}`);
    assert.equal(minute(r.c.limits[0].resetsAt), minute(r.five), `${tz} Claude 5h: ${r.md[0]}`);
    assert.equal(minute(r.c.limits[1].resetsAt), minute(r.week), `${tz} Claude weekly: ${r.md[1]}`);
    assert.equal(r.c.limits[1].utilization, 0.815);
    assert.equal(minute(r.x.limits[0].resetsAt), minute(r.five), `${tz} Codex 5h`);
    assert.equal(minute(r.x.limits[1].resetsAt), minute(r.week), `${tz} Codex weekly`);
    assert.equal(r.x.limits[1].utilization, 0.99);
  }
});

// ---------------------------------------------------------------- expiry
await test('Expiry: a window past its reset counts as reset everywhere (quotaState, text)', () => {
  const now = Date.now();
  const status = {
    id: 'claude',
    state: 'ready',
    authMethods: [],
    hasApiKey: false,
    canLogout: false,
    limits: [
      { window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: now - 1000, status: 'rejected' },
      { window: 'seven_day', label: 'Weekly limit', utilization: 0.4, resetsAt: now + 2 * 3600_000 + 30_000 },
    ],
  };
  const live = quota.liveLimits(status.limits, now);
  assert.equal(live[0].expired, true);
  assert.equal(live[0].utilization, 0);
  assert.equal(live[0].resetsAt, undefined);
  assert.equal(live[1].expired, undefined);
  assert.equal(quota.quotaState(status).out, false, 'not out once the 5-hour window reset');
  assert.equal(quota.formatLimitLine(live[0]), '5-hour limit: reset, refreshing');
  assert.match(quota.formatLimitLine(live[1]), /^Weekly limit: 40% used \(resets in 2h( 1m)?\)$/);
  status.limits[0].resetsAt = now + 60_000;
  assert.equal(quota.quotaState(status).out, true, 'out while the window is still running');
  assert.equal(quota.nextResetAt(status.limits, now), now + 60_000);
  assert.equal(quota.formatLimitsAge(now - 30_000, now), 'Updated just now');
  assert.equal(quota.formatLimitsAge(now - 4 * 60_000, now), 'Updated 4 min ago');
  assert.equal(quota.formatLimitsAge(now - 3 * 3600_000, now), 'Updated 3 h ago');
});

// ---------------------------------------------------------------- hidden probe session
function fakeRpc({ reply, commands, closeCap = true, failNew } = {}) {
  const calls = [];
  const sessions = new probe.ProbeSessions();
  const rpc = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'session/new') {
        if (failNew) throw failNew;
        const sessionId = 'probe-1';
        if (commands) setTimeout(() => sessions.offer(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: commands.map((name) => ({ name })) }), 10);
        return { sessionId };
      }
      if (method === 'session/prompt') {
        for (const part of reply) sessions.offer(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
        return { stopReason: 'end_turn' };
      }
      return {};
    },
  };
  return { rpc, calls, sessions, closeCap };
}

await test('Probe: opens a session with no MCP servers, sends exactly "/usage" as one text block, reads, closes', async () => {
  const f = fakeRpc({ reply: ['## Usage\n\n### Limits\n\n**5-hour limit** — **', '64%** · Resets Nov 16, 3:30 PM UTC\n'] });
  const r = await probe.runProbe(f.rpc, f.sessions, { agentId: 'claude', cwd: '/tmp/x', command: 'usage', canClose: true, meta: { claudeCode: { options: { persistSession: false } } }, timeoutMs: 5000, now: () => Date.parse('2026-11-16T10:00:00Z') });
  assert.deepEqual(r.limits.map((l) => [l.window, l.utilization]), [['five_hour', 0.64]]);
  assert.deepEqual(f.calls.map((c) => c[0]), ['session/new', 'session/prompt', 'session/close']);
  assert.deepEqual(f.calls[0][1], { cwd: '/tmp/x', mcpServers: [], _meta: { claudeCode: { options: { persistSession: false } } } });
  assert.deepEqual(f.calls[1][1].prompt, [{ type: 'text', text: '/usage' }]);
  assert.equal(f.sessions.has('probe-1'), false, 'collector released');
  assert.equal(f.sessions.offer('probe-1', { sessionUpdate: 'agent_message_chunk' }), false, 'later updates are not swallowed');
});

await test('Probe: an unknown agent picks its command from the advertised list; none → null; no close capability → no close', async () => {
  const f = fakeRpc({ commands: ['compact', 'status'], reply: ['**5h limit:** 90% left (resets 23:59)'] });
  const r = await probe.runProbe(f.rpc, f.sessions, { agentId: 'mock', cwd: '/tmp', canClose: false, timeoutMs: 5000 });
  assert.equal(r.command, 'status');
  assert.equal(r.limits[0].utilization, 0.1);
  assert.deepEqual(f.calls.map((c) => c[0]), ['session/new', 'session/prompt']);
  const g = fakeRpc({ commands: ['compact'], reply: [] });
  assert.equal(await probe.runProbe(g.rpc, g.sessions, { agentId: 'mock', cwd: '/tmp', canClose: true, timeoutMs: 5000 }), null);
  assert.deepEqual(g.calls.map((c) => c[0]), ['session/new', 'session/close']);
  assert.equal(probe.probeCommandFor('claude'), 'usage');
  assert.equal(probe.probeCommandFor('codex'), 'status');
  assert.equal(probe.probeCommandFor('gemini'), undefined);
  assert.equal(probe.probeCommandFor('x', ['/usage', 'status']), 'usage');
});

await test('Probe: a hung agent times out instead of hanging', async () => {
  const sessions = new probe.ProbeSessions();
  const rpc = { request: (m) => (m === 'session/new' ? Promise.resolve({ sessionId: 's' }) : new Promise(() => {})) };
  const t0 = Date.now();
  await assert.rejects(probe.runProbe(rpc, sessions, { agentId: 'claude', cwd: '/', command: 'usage', canClose: false, timeoutMs: 1200 }), /longer than/);
  assert.ok(Date.now() - t0 < 3000);
});

// ---------------------------------------------------------------- scheduling
function fakeHost(agents, readImpl) {
  const patches = [];
  const reads = [];
  const host = {
    agents: () => agents,
    reader: (id) => (id === 'antigravity' ? 'daemon' : id === 'none' ? null : 'probe'),
    mayStart: (id) => id !== 'custom',
    read: async (id, reader) => {
      reads.push([id, reader]);
      return readImpl(id, reader);
    },
    patch: (id, p) => {
      patches.push([id, p]);
      Object.assign(agents.find((a) => a.id === id), p, 'state' in p ? {} : {});
    },
  };
  return { host, patches, reads };
}
const agent = (id, extra = {}) => ({ id, state: 'ready', installed: true, running: true, busy: false, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await test('Scheduling: a reset time passing flips the status and re-reads that agent with no user action', async () => {
  const a = agent('claude', { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: Date.now() + 150 }], limitsAt: Date.now() });
  const { host, patches, reads } = fakeHost([a], () => ({ limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 0.02, resetsAt: Date.now() + 5 * 3600_000 }] }));
  const s = new svc.LimitsService({ afterResetMs: 20 });
  s.setHost(host);
  s.scheduleResets();
  await sleep(400);
  assert.ok(patches.some(([, p]) => Object.keys(p).length === 0), 'status re-emitted at the reset');
  assert.deepEqual(reads, [['claude', 'probe']]);
  assert.equal(a.limits[0].utilization, 0.02);
  s.stop();
});

await test('Scheduling: a reset during a running read re-reads afterwards when that read still had the old window', async () => {
  const resetAt = Date.now() + 120;
  const a = agent('claude', { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: resetAt }], limitsAt: Date.now() });
  let call = 0;
  const { host, reads } = fakeHost([a], async () => {
    call++;
    if (call === 1) {
      await sleep(250); // started before the reset, answers after it with the old window
      return { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: resetAt }] };
    }
    return { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 0.01, resetsAt: Date.now() + 5 * 3600_000 }] };
  });
  const s = new svc.LimitsService({ afterResetMs: 10 });
  s.setHost(host);
  void s.refresh('claude', { reason: 'interval' });
  s.scheduleResets();
  await sleep(600);
  assert.equal(reads.length, 2, 'read again after the stale in-flight read');
  assert.equal(a.limits[0].utilization, 0.01);
  s.stop();
});

await test('Scheduling: a read that ends just BEFORE the reset timer with the old window does not cancel the reset read', async () => {
  const resetAt = Date.now() + 100;
  const a = agent('claude', { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: resetAt }], limitsAt: Date.now() });
  let call = 0;
  const { host, reads } = fakeHost([a], async () => {
    call++;
    if (call === 1) {
      await sleep(150); // ends after the reset, before the timer (reset + 200 ms), still with the old window
      return { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: resetAt }] };
    }
    return { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 0.02, resetsAt: Date.now() + 5 * 3600_000 }] };
  });
  const s = new svc.LimitsService({ afterResetMs: 200 });
  s.setHost(host);
  s.scheduleResets();
  void s.refresh('claude', { reason: 'interval' });
  await sleep(700);
  assert.equal(reads.length, 2, 'the reset still triggers a read');
  assert.equal(a.limits[0].utilization, 0.02);
  s.stop();
});

await test('Scheduling: an agent that keeps returning an expired window is re-read at most once a minute', async () => {
  let t = 5_000_000;
  const a = agent('claude', { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: t - 1000 }], limitsAt: t });
  const { host, reads } = fakeHost([a], () => ({ limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: 5_000_000 - 1000 }] }));
  const s = new svc.LimitsService({ now: () => t, afterResetMs: 10 });
  s.setHost(host);
  s.scheduleResets();
  await sleep(120);
  assert.equal(reads.length, 1);
  await sleep(200);
  assert.equal(reads.length, 1, 'no loop while the clock has not moved a minute');
  s.stop();
});

await test('Scheduling: never during a live turn — put off and run when the turn ends', async () => {
  const a = agent('codex', { busy: true });
  const { host, reads } = fakeHost([a], () => ({ limits: [] , empty: true }));
  const s = new svc.LimitsService();
  s.setHost(host);
  await s.refresh('codex', { reason: 'interval' });
  assert.equal(reads.length, 0);
  a.busy = false;
  s.turnEnded('codex');
  await sleep(20);
  assert.deepEqual(reads, [['codex', 'probe']]);
  assert.ok(a.limitsAt, 'an empty read still counts as a fresh check');
});

await test('Scheduling: failures back off (2, 4, … min, capped); a forced read ignores backoff; errors shown quietly', async () => {
  let t = 1_000_000;
  const a = agent('claude');
  let fail = true;
  const { host, reads } = fakeHost([a], () => {
    if (fail) throw new Error('boom');
    return { limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 0.5 }] };
  });
  const s = new svc.LimitsService({ now: () => t });
  s.setHost(host);
  await s.refresh('claude', { reason: 'interval' });
  assert.equal(a.limitsError, 'boom');
  t += 60_000;
  await s.refresh('claude', { reason: 'interval' });
  assert.equal(reads.length, 1, 'still backing off after 1 min');
  t += 61_000;
  await s.refresh('claude', { reason: 'interval' });
  assert.equal(reads.length, 2, 'retried after 2 min');
  t += 3 * 60_000;
  await s.refresh('claude', { reason: 'interval' });
  assert.equal(reads.length, 2, 'second backoff is 4 min');
  fail = false;
  await s.refresh('claude', { reason: 'button', force: true });
  assert.equal(reads.length, 3);
  assert.equal(a.limitsError, undefined);
  assert.equal(a.limitsRefreshing, false);
});

await test('Scheduling: one read at a time per agent; fresh data is not re-read; agents outside the test filter are skipped', async () => {
  let release;
  const a = agent('claude');
  const b = agent('codex');
  let auto = false;
  const { host, reads } = fakeHost([a, b], () => (auto ? { limits: [] } : new Promise((r) => (release = () => r({ limits: [] })))));
  const s = new svc.LimitsService({ only: ['claude'] });
  s.setHost(host);
  const p1 = s.refresh('claude', { reason: 'x' });
  const p2 = s.refresh('claude', { reason: 'y', force: true });
  assert.equal(p1, p2);
  release();
  await p1;
  assert.equal(reads.length, 1);
  await s.refresh('claude', { reason: 'stale', maxAgeMs: 120_000 });
  assert.equal(reads.length, 1, 'newer than 2 min: skipped');
  a.limits = [{ window: 'five_hour', label: '5-hour limit', utilization: 1, resetsAt: Date.now() - 1 }];
  const pending = s.refresh('claude', { reason: 'stale', maxAgeMs: 120_000 });
  release();
  await pending;
  assert.equal(reads.length, 2, 'a passed reset makes young data stale');
  auto = true;
  await s.refreshAll('interval');
  assert.ok(!reads.some(([id]) => id === 'codex'), 'codex not in OLYMPUS_LIMITS_AGENTS');
});

await test('Scheduling: not-installed, logged-out, or not-running custom agents are never started; no-command agents pause', async () => {
  const agents = [agent('a', { installed: false }), agent('b', { state: 'needs-login' }), agent('custom', { running: false }), agent('none'), agent('x')];
  const { host, reads } = fakeHost(agents, (id) => (id === 'x' ? null : { limits: [] }));
  const s = new svc.LimitsService();
  s.setHost(host);
  await s.refreshAll('interval');
  assert.deepEqual(reads, [['x', 'probe']]);
  assert.equal(agents[4].limitsReadable, false);
  await s.refreshAll('interval');
  assert.equal(reads.length, 1, 'no limits command: not asked again for hours');
});

await test('Scheduling: "unavailable" (daemon not running) is neither an error nor a fresh reading', async () => {
  const a = agent('antigravity', { limits: [{ window: 'g', label: 'Gemini', utilization: 0.5 }], limitsAt: 1 });
  const { host } = fakeHost([a], () => ({ limits: [], unavailable: true }));
  const s = new svc.LimitsService();
  s.setHost(host);
  await s.refresh('antigravity', { reason: 'interval' });
  assert.equal(a.limitsAt, 1);
  assert.equal(a.limitsError, undefined);
  assert.equal(a.limits[0].utilization, 0.5);
  await s.refresh('antigravity', { reason: 'interval' });
});

await test('Scheduling: ensureFresh waits at most its timeout, the read finishes in the background', async () => {
  const a = agent('claude');
  const { host } = fakeHost([a], () => sleep(500).then(() => ({ limits: [{ window: 'five_hour', label: '5-hour limit', utilization: 0.1 }] })));
  const s = new svc.LimitsService();
  s.setHost(host);
  const t0 = Date.now();
  await s.ensureFresh(100);
  assert.ok(Date.now() - t0 < 300);
  assert.equal(a.limits, undefined);
  await sleep(600);
  assert.equal(a.limits[0].utilization, 0.1);
});

console.log(`\n${n} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
