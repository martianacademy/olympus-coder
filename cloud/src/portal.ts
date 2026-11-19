/**
 * Clean, uncluttered developer web portal & Merchant-of-Record checkout router (`GET /`, `GET /cloud`,
 * `GET /v1/billing/checkout`) served directly from the `olympus-cloud` Cloudflare Worker.
 *
 * Design: monochrome dark-first developer aesthetic, zero hype/clutter, clear zero-content-logging guarantee.
 */

import type { AuthenticatedUser, WalletSnapshot } from './types.js';

export interface CheckoutLinksConfig {
  starterUrl?: string;
  proUrl?: string;
  maxUrl?: string;
  topup10Url?: string;
}

export type CheckoutTarget = 'starter' | 'pro' | 'max' | 'topup10';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_CSS = `
  :root { color-scheme: dark; --bg: #0b0c0e; --card: #121418; --border: #23262d; --fg: #eceef2; --muted: #8b919e; --accent: #f4f5f7; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; line-height: 1.5; padding: 48px 20px; }
  .wrap { max-width: 880px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 32px; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 14px; margin-top: 6px; }
  .pill { font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin: 24px 0; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; }
  .tier { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .price { font-size: 26px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 4px; }
  .price span { font-size: 13px; color: var(--muted); font-weight: 400; }
  .meta { font-size: 13px; color: var(--muted); list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .btn { display: inline-block; text-align: center; background: var(--accent); color: #0b0c0e; font-size: 13px; font-weight: 600; text-decoration: none; padding: 9px 14px; border-radius: 7px; border: 1px solid var(--accent); cursor: pointer; }
  .btn-ghost { background: transparent; color: var(--fg); border-color: var(--border); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: #0e1014; border: 1px solid var(--border); border-radius: 8px; padding: 14px; overflow-x: auto; color: #d5d9e2; margin-top: 10px; }
  .note { font-size: 13px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 20px; margin-top: 28px; }
`;

export function renderLandingPage(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Olympus Cloud — Multi-Model Coding Credits</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Olympus Cloud</h1>
        <p class="sub">Unified multi-model credits for Olympus CLI (<code>oly</code>). Olympus Coder desktop stays 100% free with no login required.</p>
      </div>
      <span class="pill">Zero prompt &amp; code logging</span>
    </header>

    <div class="card" style="margin-bottom: 24px;">
      <div>
        <div class="tier">Quick Sign-In</div>
        <p class="sub" style="margin-top: 4px;">Run <code>oly login</code> in your terminal for automatic 1-click sign-in, or sign in via GitHub below to generate an API token.</p>
      </div>
      <div>
        <a class="btn" href="${escapeHtml(origin)}/v1/auth/github/start">Continue with GitHub</a>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div>
          <div class="tier">Starter</div>
          <div class="price">$20 <span>/ mo</span></div>
        </div>
        <ul class="meta">
          <li>2,000 monthly credits</li>
          <li>Claude 5.5, GPT-5, Gemini, Kimi, DeepSeek</li>
          <li>Prompt caching enabled</li>
        </ul>
      </div>
      <div class="card">
        <div>
          <div class="tier">Pro</div>
          <div class="price">$60 <span>/ mo</span></div>
        </div>
        <ul class="meta">
          <li>6,200 monthly credits</li>
          <li>Heavy multi-file Opus &amp; Sonnet loops</li>
          <li>Automatic multi-provider failover</li>
        </ul>
      </div>
      <div class="card">
        <div>
          <div class="tier">Max</div>
          <div class="price">$100 <span>/ mo</span></div>
        </div>
        <ul class="meta">
          <li>10,500 monthly credits</li>
          <li>Parallel sub-session orchestration</li>
          <li>Non-expiring top-up packs</li>
        </ul>
      </div>
      <div class="card">
        <div>
          <div class="tier">Top-Up Pack</div>
          <div class="price">$10 <span>one-time</span></div>
        </div>
        <ul class="meta">
          <li>1,000 non-expiring credits</li>
          <li>No subscription required</li>
          <li>Stacks with any active plan</li>
        </ul>
      </div>
    </div>

    <p class="note"><strong>Need $0 coding?</strong> Use your own OpenRouter, Anthropic, OpenAI, or Vercel AI Gateway key, Local Ollama, or any of the 18 free coding CLIs directly in Olympus Coder — zero Olympus account required.<br /><br /><strong>Privacy guarantee:</strong> Olympus Cloud is a stateless pass-through proxy. Prompts, files, and model outputs stay on your machine (<code>~/.olympus</code>) and are never stored on our servers; only numeric token counts are recorded for billing.</p>
  </div>
</body>
</html>`;
}

export function renderPortalTokenPage(opts: {
  email: string;
  token: string;
  wallet: WalletSnapshot;
  giftGranted: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Olympus Cloud — Account &amp; Token</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Signed in as ${escapeHtml(opts.email)}</h1>
        <p class="sub">Plan: <strong>${escapeHtml(opts.wallet.plan === 'free' ? 'NO ACTIVE PLAN' : opts.wallet.plan.toUpperCase())}</strong> · Available credits: <strong>${opts.wallet.availableCredits.toFixed(2)}</strong>${opts.wallet.availableCredits <= 0 ? ' — choose a plan or top-up below to activate Olympus Cloud models' : ''}</p>
      </div>
      <span class="pill">Zero prompt &amp; code logging</span>
    </header>

    <div class="card">
      <div>
        <div class="tier">Your Olympus Cloud Token (shown once)</div>
        <p class="sub" style="margin-top: 4px;">Copy this token into <code>oly login</code> or Olympus Coder &rarr; Settings &rarr; Agents &rarr; Olympus.</p>
        <pre>${escapeHtml(opts.token)}</pre>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div><div class="tier">Starter</div><div class="price">$20<span>/mo</span></div><p class="sub">2,000 credits / mo</p></div>
        <form method="POST" action="/v1/billing/checkout"><input type="hidden" name="target" value="starter" /><input type="hidden" name="token" value="${escapeHtml(opts.token)}" /><button type="submit" class="btn btn-ghost" style="width:100%">Upgrade to Starter</button></form>
      </div>
      <div class="card">
        <div><div class="tier">Pro</div><div class="price">$60<span>/mo</span></div><p class="sub">6,200 credits / mo</p></div>
        <form method="POST" action="/v1/billing/checkout"><input type="hidden" name="target" value="pro" /><input type="hidden" name="token" value="${escapeHtml(opts.token)}" /><button type="submit" class="btn btn-ghost" style="width:100%">Upgrade to Pro</button></form>
      </div>
      <div class="card">
        <div><div class="tier">Max</div><div class="price">$100<span>/mo</span></div><p class="sub">10,500 credits / mo</p></div>
        <form method="POST" action="/v1/billing/checkout"><input type="hidden" name="target" value="max" /><input type="hidden" name="token" value="${escapeHtml(opts.token)}" /><button type="submit" class="btn btn-ghost" style="width:100%">Upgrade to Max</button></form>
      </div>
      <div class="card">
        <div><div class="tier">Top-Up Pack</div><div class="price">$10</div><p class="sub">1,000 non-expiring credits</p></div>
        <form method="POST" action="/v1/billing/checkout"><input type="hidden" name="target" value="topup10" /><input type="hidden" name="token" value="${escapeHtml(opts.token)}" /><button type="submit" class="btn btn-ghost" style="width:100%">Buy Top-Up</button></form>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Build a Merchant-of-Record (Dodo Payments / Polar.sh) hosted checkout redirect URL with
 * `metadata[userId]` and `prefilled_email` bound to the authenticated Olympus Cloud user.
 */
export function buildCheckoutRedirectUrl(
  target: string,
  user: AuthenticatedUser,
  links: CheckoutLinksConfig,
): string | null {
  const map: Record<CheckoutTarget, string | undefined> = {
    starter: links.starterUrl,
    pro: links.proUrl,
    max: links.maxUrl,
    topup10: links.topup10Url,
  };
  const base = map[target as CheckoutTarget];
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set('metadata[userId]', user.userId);
  u.searchParams.set('prefilled_email', user.email);
  return u.toString();
}
