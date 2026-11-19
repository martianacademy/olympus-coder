/**
 * GitHub OAuth 2.0 browser sign-in flow for Olympus Cloud (`/v1/auth/github/start` and `/v1/auth/github/callback`).
 *
 * Security controls:
 * 1. CSRF & state integrity: OAuth `state` embeds `{ nonce, cliPort, cliState, expMs }` signed with HMAC-SHA256
 *    AND bound to an `HttpOnly; SameSite=Lax` cookie (`oly_oauth_nonce`), preventing login CSRF.
 * 2. Open-redirect prevention: `cli_port` is strictly validated as an integer `1024..65535` and redirects ONLY
 *    to `http://127.0.0.1:<port>/callback` — arbitrary external `redirect_uri` values are never accepted.
 * 3. Paid-only billing invariant: OAuth sign-in issues a SHA-256-hashed API token with `0` initial credits;
 *    paid credits are granted strictly through verified billing webhooks (`subscription.active` / `order.paid`).
 */

import { generateOlympusToken, sha256Hex, signHmacSha256Hex } from './auth.js';
import { renderPortalTokenPage } from './portal.js';
import type { CloudMetadataStore } from './types.js';
import type { WalletClient } from './app.js';

export const GITHUB_MIN_ACCOUNT_AGE_MS = 30 * 86_400_000;
const STATE_TTL_MS = 10 * 60_000;
const NONCE_COOKIE = 'oly_oauth_nonce';

export interface OAuthConfig {
  githubClientId?: string;
  githubClientSecret?: string;
  oauthStateSecret?: string;
  githubAuthorizeUrl?: string;
  githubTokenUrl?: string;
  githubApiBaseUrl?: string;
}

interface SignedOAuthState {
  nonce: string;
  cliPort?: number;
  cliState?: string;
  expMs: number;
}

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64: string): string {
  const pad = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function constantTimeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function parseValidCliPort(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (!/^\d{4,5}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : undefined;
}

async function encodeSignedState(payload: SignedOAuthState, secret: string): Promise<string> {
  const body = toBase64Url(JSON.stringify(payload));
  const sig = await signHmacSha256Hex(secret, body);
  return `${body}.${sig}`;
}

async function decodeSignedState(token: string, secret: string, nowMs: number): Promise<SignedOAuthState | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sig)) return null;
  const expected = await signHmacSha256Hex(secret, body);
  if (!constantTimeHexEq(sig, expected)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(body)) as SignedOAuthState;
    if (!parsed || typeof parsed.nonce !== 'string' || typeof parsed.expMs !== 'number') return null;
    if (nowMs > parsed.expMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function handleGitHubOAuthStart(req: Request, cfg: OAuthConfig, nowMs: number): Promise<Response> {
  if (!cfg.githubClientId || !cfg.githubClientSecret || !cfg.oauthStateSecret) {
    return Response.json(
      { error: { code: 'OAUTH_NOT_CONFIGURED', message: 'GitHub OAuth is not configured on this Olympus Cloud instance.' } },
      { status: 503 },
    );
  }

  const reqUrl = new URL(req.url);
  const rawPort = reqUrl.searchParams.get('cli_port');
  const cliPort = parseValidCliPort(rawPort);
  if (rawPort !== null && cliPort === undefined) {
    return Response.json({ error: { code: 'INVALID_CLI_PORT', message: 'cli_port must be an integer between 1024 and 65535.' } }, { status: 400 });
  }
  const cliState = reqUrl.searchParams.get('cli_state')?.trim() || undefined;
  if (cliState && !/^[A-Za-z0-9_-]{16,128}$/.test(cliState)) {
    return Response.json({ error: { code: 'INVALID_CLI_STATE', message: 'Invalid cli_state format.' } }, { status: 400 });
  }

  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  const signedState = await encodeSignedState(
    {
      nonce,
      ...(cliPort ? { cliPort } : {}),
      ...(cliState ? { cliState } : {}),
      expMs: nowMs + STATE_TTL_MS,
    },
    cfg.oauthStateSecret,
  );

  const callbackUrl = `${reqUrl.origin}/v1/auth/github/callback`;
  const authBase = cfg.githubAuthorizeUrl || 'https://github.com/login/oauth/authorize';
  const target = new URL(authBase);
  target.searchParams.set('client_id', cfg.githubClientId);
  target.searchParams.set('redirect_uri', callbackUrl);
  target.searchParams.set('scope', 'read:user user:email');
  target.searchParams.set('state', signedState);

  const secureAttr = reqUrl.protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Set-Cookie': `${NONCE_COOKIE}=${nonce}; Path=/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=600${secureAttr}`,
    },
  });
}

export async function handleGitHubOAuthCallback(
  req: Request,
  cfg: OAuthConfig,
  metadata: CloudMetadataStore,
  getWallet: (userId: string) => WalletClient,
  fetchFn: typeof fetch,
  nowMs: number,
): Promise<Response> {
  if (!cfg.githubClientId || !cfg.githubClientSecret || !cfg.oauthStateSecret) {
    return Response.json({ error: { code: 'OAUTH_NOT_CONFIGURED', message: 'GitHub OAuth is not configured.' } }, { status: 503 });
  }

  const reqUrl = new URL(req.url);
  const code = reqUrl.searchParams.get('code')?.trim();
  const stateParam = reqUrl.searchParams.get('state')?.trim();
  if (!code || !stateParam) {
    return Response.json({ error: { code: 'MISSING_OAUTH_PARAMS', message: 'Missing code or state parameter.' } }, { status: 400 });
  }

  const state = await decodeSignedState(stateParam, cfg.oauthStateSecret, nowMs);
  const cookieNonce = readCookie(req.headers.get('cookie'), NONCE_COOKIE);
  if (!state || !cookieNonce || !constantTimeHexEq(state.nonce, cookieNonce)) {
    return Response.json({ error: { code: 'INVALID_OAUTH_STATE', message: 'OAuth session expired or state mismatch. Run `oly login` again.' } }, { status: 400 });
  }

  // 1. Exchange authorization code for GitHub access token
  const tokenUrl = cfg.githubTokenUrl || 'https://github.com/login/oauth/access_token';
  const tokenRes = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'olympus-cloud' },
    body: JSON.stringify({
      client_id: cfg.githubClientId,
      client_secret: cfg.githubClientSecret,
      code,
      redirect_uri: `${reqUrl.origin}/v1/auth/github/callback`,
    }),
  });
  if (!tokenRes.ok) {
    return Response.json({ error: { code: 'GITHUB_TOKEN_FAILED', message: `GitHub token exchange failed (${tokenRes.status}).` } }, { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
  const accessToken = typeof tokenJson.access_token === 'string' ? tokenJson.access_token.trim() : '';
  if (!accessToken) {
    return Response.json({ error: { code: 'GITHUB_NO_TOKEN', message: 'GitHub did not return an access token.' } }, { status: 400 });
  }

  // 2. Fetch GitHub user profile + primary verified email
  const apiBase = (cfg.githubApiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
  const ghHeaders = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'olympus-cloud' };
  const userRes = await fetchFn(`${apiBase}/user`, { headers: ghHeaders });
  if (!userRes.ok) {
    return Response.json({ error: { code: 'GITHUB_USER_FAILED', message: `GitHub /user failed (${userRes.status}).` } }, { status: 502 });
  }
  const ghUser = (await userRes.json()) as Record<string, unknown>;
  const githubId = String(ghUser.id ?? '').trim();
  const createdAtMs = Date.parse(String(ghUser.created_at ?? '')) || nowMs;
  let email = typeof ghUser.email === 'string' && ghUser.email.includes('@') ? ghUser.email.trim().toLowerCase() : '';

  if (!email) {
    const emailsRes = await fetchFn(`${apiBase}/user/emails`, { headers: ghHeaders });
    if (emailsRes.ok) {
      const list = (await emailsRes.json()) as Array<Record<string, unknown>>;
      const primary = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified);
      if (primary && typeof primary.email === 'string') email = primary.email.trim().toLowerCase();
    }
  }
  if (!githubId || !email) {
    return Response.json({ error: { code: 'GITHUB_EMAIL_REQUIRED', message: 'A verified email on your GitHub account is required.' } }, { status: 400 });
  }

  // 3. Issue Olympus Cloud token (only SHA-256 hash is stored in D1); accounts start at 0 credits until a paid plan/top-up is purchased
  const olyToken = generateOlympusToken();
  const tokenHash = await sha256Hex(olyToken);
  const label = state.cliPort ? 'oly-cli' : 'web-portal';
  const { user } = await metadata.upsertOAuthUser({ githubId, email, githubCreatedAtMs: createdAtMs }, tokenHash, label);

  const wallet = getWallet(user.userId);
  const snap = await wallet.snapshot(nowMs);

  const clearCookie = `${NONCE_COOKIE}=; Path=/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=0`;

  // 4. Redirect to local `oly login` loopback callback (`127.0.0.1:<cliPort>`) OR show web portal token screen
  if (state.cliPort) {
    const cb = new URL(`http://127.0.0.1:${state.cliPort}/callback`);
    cb.searchParams.set('token', olyToken);
    cb.searchParams.set('email', user.email);
    cb.searchParams.set('plan', snap.plan);
    if (state.cliState) cb.searchParams.set('state', state.cliState);
    return new Response(null, {
      status: 302,
      headers: { Location: cb.toString(), 'Set-Cookie': clearCookie },
    });
  }

  return new Response(renderPortalTokenPage({ email: user.email, token: olyToken, wallet: snap, giftGranted: false }), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie },
  });
}
