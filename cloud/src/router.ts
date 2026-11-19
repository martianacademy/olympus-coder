/**
 * Stateless zero-content-logging multi-upstream SSE proxy with automatic circuit-breaker failover.
 *
 * Security & privacy guarantee:
 * - Request prompts and streamed response text are forwarded directly and NEVER logged, persisted, or retained.
 * - Only numeric token usage fields (`input`, `cachedRead`, `cachedWrite`, `cachedWrite1h`, `output`) are
 *   extracted on the fly as SSE frames pass through a zero-buffering `TransformStream`.
 */

import type {
  ApiProtocol,
  ModelSpec,
  TokenUsageCounts,
  UpstreamCredential,
  UpstreamId,
  UpstreamRoute,
} from './types.js';

export interface BudgetController {
  isUpstreamHealthy(upstream: UpstreamId, nowMs?: number): Promise<boolean>;
  recordUpstreamSuccess(upstream: UpstreamId, nowMs?: number): Promise<void>;
  recordUpstreamFailure(upstream: UpstreamId, reason: string, nowMs?: number): Promise<{ tripped: boolean; openUntilMs: number }>;
}

export interface ProxyAttemptResult {
  response: Response;
  upstream: UpstreamId;
  upstreamModel: string;
  failedOverFrom: UpstreamId[];
}

export interface ProxyOptions {
  model: ModelSpec;
  protocol: ApiProtocol;
  rawBody: Record<string, unknown>;
  officialOnly: boolean;
  upstreams: Partial<Record<UpstreamId, UpstreamCredential>>;
  budget: BudgetController;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
  onComplete: (outcome: {
    upstream: UpstreamId;
    statusCode: number;
    latencyMs: number;
    usage: TokenUsageCounts;
  }) => Promise<void>;
}

export function emptyTokenUsage(): TokenUsageCounts {
  return {
    inputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    cachedWrite1hTokens: 0,
    outputTokens: 0,
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Merge OpenAI, OpenRouter, or Anthropic usage objects into normalized `TokenUsageCounts`. */
export function mergeUsageChunk(target: TokenUsageCounts, parsed: Record<string, unknown>, protocol: ApiProtocol): void {
  if (protocol === 'anthropic') {
    const msg = asRecord(parsed.message);
    const u = asRecord(msg?.usage) ?? asRecord(parsed.usage);
    if (!u) return;
    if (u.input_tokens != null) target.inputTokens = Number(u.input_tokens);
    if (u.output_tokens != null) target.outputTokens = Number(u.output_tokens);
    if (u.cache_read_input_tokens != null) target.cachedReadTokens = Number(u.cache_read_input_tokens);
    const cc = asRecord(u.cache_creation);
    if (u.cache_creation_input_tokens != null || cc !== undefined) {
      const cw1h = cc?.ephemeral_1h_input_tokens != null ? Number(cc.ephemeral_1h_input_tokens) : target.cachedWrite1hTokens;
      const cw5m = cc?.ephemeral_5m_input_tokens != null ? Number(cc.ephemeral_5m_input_tokens) : 0;
      const cwTotal = u.cache_creation_input_tokens != null ? Number(u.cache_creation_input_tokens) : cw5m + cw1h;
      target.cachedWrite1hTokens = cw1h;
      target.cachedWriteTokens = Math.max(0, cwTotal - cw1h);
    }
    return;
  }

  const u = asRecord(parsed.usage);
  if (!u) return;
  const pd = asRecord(u.prompt_tokens_details);
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  const cached = Number(pd?.cached_tokens ?? u.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(pd?.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0);
  if (prompt > 0 || u.prompt_tokens != null || u.input_tokens != null) {
    target.inputTokens = Math.max(0, prompt - cached - cacheWrite);
  }
  if (cached > 0) target.cachedReadTokens = cached;
  if (cacheWrite > 0) target.cachedWriteTokens = cacheWrite;
  if (completion > 0) target.outputTokens = completion;
}

/**
 * Resolve ordered upstream routes matching the requested wire protocol, configured API credentials,
 * and `officialOnly` (ZDR) policy.
 */
export function selectUpstreamCandidates(
  model: ModelSpec,
  upstreams: Partial<Record<UpstreamId, UpstreamCredential>>,
  protocol: ApiProtocol,
  officialOnly: boolean,
): UpstreamRoute[] {
  return model.routes.filter((r) => {
    if (r.protocol !== protocol) return false;
    if (officialOnly && !r.official) return false;
    const cred = upstreams[r.upstream];
    return Boolean(cred && cred.baseUrl && cred.apiKey);
  });
}

function buildUpstreamUrl(baseUrl: string, protocol: ApiProtocol): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  return protocol === 'anthropic' ? `${clean}/messages` : `${clean}/chat/completions`;
}

function buildUpstreamHeaders(cred: UpstreamCredential, protocol: ApiProtocol): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    ...(cred.extraHeaders ?? {}),
  };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = cred.apiKey;
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${cred.apiKey}`;
  }
  return headers;
}

const RETRYABLE_STATUSES = new Set([404, 429, 500, 502, 503, 504]);

function prepareBodyForRoute(rawBody: Record<string, unknown>, route: UpstreamRoute): string {
  const next: Record<string, unknown> = {
    ...rawBody,
    model: route.upstreamModel,
  };
  if (route.protocol === 'openai' && next.stream === true && next.stream_options === undefined) {
    next.stream_options = { include_usage: true };
  }
  return JSON.stringify(next);
}

/**
 * Proxy an OpenAI or Anthropic completion request with circuit-breaker health filtering, automatic
 * pre-stream failover, and zero-buffering SSE token accounting.
 */
export async function proxyWithFailover(opts: ProxyOptions): Promise<ProxyAttemptResult | { errorResponse: Response }> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const nowFn = opts.nowMs ?? (() => Date.now());
  const candidates = selectUpstreamCandidates(opts.model, opts.upstreams, opts.protocol, opts.officialOnly);

  if (!candidates.length) {
    return {
      errorResponse: Response.json(
        {
          error: {
            type: 'upstream_unavailable',
            message: opts.officialOnly
              ? `No official ZDR upstream is configured for model "${opts.model.id}" (${opts.protocol}).`
              : `No upstream is configured for model "${opts.model.id}" (${opts.protocol}).`,
          },
        },
        { status: 503 },
      ),
    };
  }

  // Filter healthy routes first; if every route has an open breaker, fall back to the last official route.
  const healthy: UpstreamRoute[] = [];
  for (const r of candidates) {
    if (await opts.budget.isUpstreamHealthy(r.upstream, nowFn())) healthy.push(r);
  }
  const ordered = healthy.length ? healthy : [candidates.find((r) => r.official) ?? candidates[candidates.length - 1]];

  const failedOverFrom: UpstreamId[] = [];
  let lastStatus = 502;
  let lastErrorText = 'All upstreams failed.';

  for (let idx = 0; idx < ordered.length; idx++) {
    const route = ordered[idx];
    const cred = opts.upstreams[route.upstream]!;
    const startedAt = nowFn();

    let upstreamRes: Response;
    try {
      upstreamRes = await fetchFn(buildUpstreamUrl(cred.baseUrl, route.protocol), {
        method: 'POST',
        headers: buildUpstreamHeaders(cred, route.protocol),
        body: prepareBodyForRoute(opts.rawBody, route),
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      await opts.budget.recordUpstreamFailure(route.upstream, reason, nowFn());
      failedOverFrom.push(route.upstream);
      lastStatus = 502;
      lastErrorText = `Upstream network error (${route.upstream}): ${reason}`;
      continue;
    }

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => '');
      lastStatus = upstreamRes.status;
      lastErrorText = errBody || `Upstream HTTP ${upstreamRes.status}`;
      if (RETRYABLE_STATUSES.has(upstreamRes.status)) {
        if (upstreamRes.status !== 404) {
          await opts.budget.recordUpstreamFailure(route.upstream, `HTTP ${upstreamRes.status}`, nowFn());
        }
        failedOverFrom.push(route.upstream);
        if (idx < ordered.length - 1) continue;
      }
      return {
        errorResponse: new Response(errBody || JSON.stringify({ error: { message: lastErrorText } }), {
          status: upstreamRes.status,
          headers: {
            'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
            'x-olympus-upstream': route.upstream,
          },
        }),
      };
    }

    await opts.budget.recordUpstreamSuccess(route.upstream, nowFn());
    const ctype = (upstreamRes.headers.get('content-type') ?? '').toLowerCase();
    const outHeaders = new Headers({
      'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'x-olympus-upstream': route.upstream,
      'x-olympus-official': route.official ? '1' : '0',
    });
    if (failedOverFrom.length) outHeaders.set('x-olympus-failover-from', failedOverFrom.join(','));

    // Non-streaming JSON response: parse usage directly and settle synchronously before returning.
    if (!ctype.includes('text/event-stream') || !upstreamRes.body) {
      const rawText = await upstreamRes.text();
      const usage = emptyTokenUsage();
      try {
        const parsed = asRecord(JSON.parse(rawText));
        if (parsed) mergeUsageChunk(usage, parsed, route.protocol);
      } catch {
        /* non-JSON body */
      }
      const finishPromise = opts.onComplete({
        upstream: route.upstream,
        statusCode: upstreamRes.status,
        latencyMs: Math.max(0, nowFn() - startedAt),
        usage,
      });
      if (opts.waitUntil) opts.waitUntil(finishPromise);
      else await finishPromise;
      return {
        response: new Response(rawText, { status: upstreamRes.status, headers: outHeaders }),
        upstream: route.upstream,
        upstreamModel: route.upstreamModel,
        failedOverFrom,
      };
    }

    // Streaming SSE response: zero-buffering pass-through that reads ONLY numeric usage counters.
    const usage = emptyTokenUsage();
    const decoder = new TextDecoder();
    let sseLineBuf = '';
    let settled = false;

    const finalize = () => {
      if (settled) return;
      settled = true;
      const p = opts.onComplete({
        upstream: route.upstream,
        statusCode: upstreamRes.status,
        latencyMs: Math.max(0, nowFn() - startedAt),
        usage,
      });
      if (opts.waitUntil) opts.waitUntil(p);
      else void p;
    };

    const parseSseLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]' || !payload.includes('usage')) return;
      try {
        const parsed = asRecord(JSON.parse(payload));
        if (parsed) mergeUsageChunk(usage, parsed, route.protocol);
      } catch {
        /* ignore partial or non-JSON frame */
      }
    };

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        sseLineBuf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = sseLineBuf.indexOf('\n')) >= 0) {
          parseSseLine(sseLineBuf.slice(0, nl));
          sseLineBuf = sseLineBuf.slice(nl + 1);
        }
      },
      flush() {
        sseLineBuf += decoder.decode();
        if (sseLineBuf.trim()) {
          for (const rem of sseLineBuf.split('\n')) parseSseLine(rem);
        }
        finalize();
      },
    });

    const readable = upstreamRes.body.pipeThrough(transform);
    return {
      response: new Response(readable, { status: upstreamRes.status, headers: outHeaders }),
      upstream: route.upstream,
      upstreamModel: route.upstreamModel,
      failedOverFrom,
    };
  }

  return {
    errorResponse: Response.json(
      { error: { type: 'upstream_failed', message: lastErrorText, tried: failedOverFrom } },
      { status: lastStatus },
    ),
  };
}
