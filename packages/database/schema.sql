-- PortalOps core schema (PRD §13). SQLite for local development; kept portable so a PostgreSQL
-- migration is a type-mapping exercise (TEXT -> text/jsonb/timestamptz, INTEGER -> bigint/boolean).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,          -- stored lower-case
  password_hash  TEXT NOT NULL,                 -- scrypt, see apps/api/auth.ts; "!oauth" for accounts created through GitHub (no password)
  created_at     TEXT NOT NULL,
  email_verified_at TEXT,                       -- set when the user proves they own the address (email link, password reset, or GitHub)
  github_id      TEXT,                          -- GitHub's numeric user id (stable, unlike the login)
  github_login   TEXT,
  totp_secret     TEXT,                         -- AES-256-GCM envelope of the base32 shared secret (set when two-factor setup begins)
  totp_enabled_at TEXT,                         -- set once the user has proved their authenticator works; NULL = two-factor is off
  totp_last_step  INTEGER,                      -- the last 30-second step accepted, so a code cannot be used twice
  recovery_codes  TEXT                          -- JSON array of sha256 hashes of the unused recovery codes
);

-- Single-use, expiring tokens for "verify your email" and "reset your password". Only a hash is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- 'verify_email' | 'reset_password'
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                 -- sha256 of the opaque cookie value; the raw token is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- owner_id/description/kind are added to pre-existing databases by Store.migrate().
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL only for the public read-only demo project
  kind        TEXT NOT NULL DEFAULT 'user',                  -- user | public_demo
  network_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  address             TEXT NOT NULL,            -- lower-case 0x…
  name                TEXT,
  runtime_type        TEXT NOT NULL DEFAULT 'evm',
  abi                 TEXT,                     -- JSON, optional; without it logs are stored undecoded
  start_block         INTEGER,
  deployment_tx_hash  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL,
  UNIQUE (project_id, address)
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  trigger_event_name  TEXT,                     -- NULL = any event
  trigger_contract    TEXT,                     -- NULL = any contract
  endpoint_id         TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  metadata    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_project_time ON audit_logs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chain_cursors (
  project_id               TEXT NOT NULL,
  network_id               TEXT NOT NULL,
  last_processed_block     INTEGER NOT NULL,
  last_processed_block_hash TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  PRIMARY KEY (project_id, network_id)
);

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,           -- deterministic, see event-engine/normalize.ts
  project_id       TEXT NOT NULL,
  network_id       TEXT NOT NULL,
  source           TEXT NOT NULL,
  chain_id         INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_name       TEXT,
  decoded          INTEGER NOT NULL,
  topics           TEXT NOT NULL,              -- JSON array
  data             TEXT NOT NULL,
  payload          TEXT,                       -- JSON or NULL
  transaction_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  block_number     INTEGER NOT NULL,
  block_hash       TEXT NOT NULL,
  event_index      INTEGER NOT NULL,
  observed_at      TEXT NOT NULL,
  finality_status  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project_block ON events (project_id, block_number DESC, event_index);
CREATE INDEX IF NOT EXISTS events_tx ON events (transaction_hash);
CREATE INDEX IF NOT EXISTS events_contract ON events (project_id, contract_address);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  url              TEXT NOT NULL,
  description      TEXT,
  encrypted_secret TEXT NOT NULL,              -- AES-256-GCM, never plaintext
  enabled          INTEGER NOT NULL DEFAULT 1,
  event_filter     TEXT NOT NULL DEFAULT '[]',
  retry_policy     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL REFERENCES events(id),
  endpoint_id          TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,          -- initial | replay
  status               TEXT NOT NULL,          -- pending | retrying | delivered | failed
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT,
  last_response_status INTEGER,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS deliveries_event ON webhook_deliveries (event_id);
-- At most one initial delivery per (event, endpoint); replays are unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_initial_once ON webhook_deliveries (event_id, endpoint_id) WHERE kind = 'initial';

CREATE TABLE IF NOT EXISTS webhook_attempts (
  id                   TEXT PRIMARY KEY,
  delivery_id          TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number       INTEGER NOT NULL,
  started_at           TEXT NOT NULL,
  finished_at          TEXT NOT NULL,
  response_status      INTEGER,
  response_duration_ms INTEGER NOT NULL,
  sanitised_response   TEXT,
  error_code           TEXT,
  UNIQUE (delivery_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  level      TEXT NOT NULL,
  area       TEXT NOT NULL,                    -- rpc | ingest | decode | webhook | replay | auth | config
  message    TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_project_time ON logs (project_id, created_at DESC);

-- Liveness of background services (the worker writes a heartbeat every pass; the API reports it).
CREATE TABLE IF NOT EXISTS service_status (
  name        TEXT PRIMARY KEY,
  updated_at  TEXT NOT NULL,
  detail      TEXT
);

-- Project-scoped API keys for programmatic access (PRD §15). Only a SHA-256 of the key is stored; the key itself is shown once.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,                   -- read | write
  prefix       TEXT NOT NULL,                   -- first characters of the key, for recognising it in lists; not secret
  key_hash     TEXT NOT NULL UNIQUE,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  expires_at   TEXT                             -- NULL = never expires
);
CREATE INDEX IF NOT EXISTS api_keys_project ON api_keys (project_id);

-- Built-in test receiver (PRD §8.9): a PortalOps-hosted sink so the full delivery workflow can be verified without a backend.
CREATE TABLE IF NOT EXISTS test_receivers (
  id          TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL UNIQUE REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,             -- sha256 of the URL token; looked up by hash
  mode        TEXT NOT NULL DEFAULT 'ok',       -- ok | fail500 | fail400 | timeout
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receiver_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receiver_id      TEXT NOT NULL REFERENCES test_receivers(id) ON DELETE CASCADE,
  received_at      TEXT NOT NULL,
  event_id         TEXT,
  delivery_id      TEXT,
  attempt          INTEGER,
  signature_ok     INTEGER NOT NULL,
  signature_reason TEXT,
  outcome          TEXT NOT NULL,               -- ok | duplicate | rejected | fail500 | fail400 | timeout
  http_status      INTEGER NOT NULL,
  body_preview     TEXT
);
CREATE INDEX IF NOT EXISTS receiver_requests_recv ON receiver_requests (receiver_id, id DESC);

-- Request counters shared by every API instance (used when PORTALOPS_RATE_LIMIT_STORE=database). Fixed windows, pruned as they expire.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);
