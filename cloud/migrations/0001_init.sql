-- Olympus Cloud D1 Schema — Zero-Content-Logging Billing & Auth Metadata ONLY.
-- No prompt text, code snippets, tool outputs, or model replies are ever stored here.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  github_id TEXT UNIQUE,
  github_created_at INTEGER,
  plan TEXT NOT NULL DEFAULT 'free', -- 'free' | 'starter' | 'pro' | 'max'
  official_only INTEGER NOT NULL DEFAULT 0, -- 1 = strict ZDR official upstreams only
  mor_customer_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY, -- SHA-256 hex of `oly_live_...` (raw token is never stored)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'cli',
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, -- MoR subscription id (Dodo Payments / Polar.sh)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'dodo' | 'polar'
  plan TEXT NOT NULL, -- 'starter' | 'pro' | 'max'
  status TEXT NOT NULL, -- 'active' | 'past_due' | 'cancelled'
  current_period_end INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT NOT NULL,
  lane TEXT NOT NULL, -- 'free' | 'paid'
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_read_tokens INTEGER NOT NULL DEFAULT 0,
  cached_write_tokens INTEGER NOT NULL DEFAULT 0,
  cached_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  upstream_cost_usd REAL NOT NULL DEFAULT 0,
  credits_charged REAL NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_time ON usage_ledger(user_id, created_at DESC);
