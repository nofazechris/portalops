-- PortalOps schema for PostgreSQL. Mirrors schema.sql (SQLite) table for table and column for column so the shared store SQL
-- runs unchanged. Deliberate simplifications, kept identical across both engines so behaviour matches:
--   * timestamps are ISO-8601 UTC strings in TEXT columns (they sort and compare correctly as text);
--   * JSON documents are TEXT; booleans are INTEGER 0/1.
-- Tables are created in dependency order (PostgreSQL, unlike SQLite, resolves foreign keys at CREATE time).

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Email verification and GitHub sign-in. Accounts that existed before these columns are treated as verified exactly once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified_at') THEN
    ALTER TABLE users ADD COLUMN email_verified_at TEXT;
    UPDATE users SET email_verified_at = created_at;
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_github ON users (github_id) WHERE github_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'user',
  network_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  address             TEXT NOT NULL,
  name                TEXT,
  runtime_type        TEXT NOT NULL DEFAULT 'evm',
  abi                 TEXT,
  start_block         INTEGER,
  deployment_tx_hash  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL,
  UNIQUE (project_id, address)
);

CREATE TABLE IF NOT EXISTS chain_cursors (
  project_id                TEXT NOT NULL,
  network_id                TEXT NOT NULL,
  last_processed_block      INTEGER NOT NULL,
  last_processed_block_hash TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  PRIMARY KEY (project_id, network_id)
);

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  network_id       TEXT NOT NULL,
  source           TEXT NOT NULL,
  chain_id         INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_name       TEXT,
  decoded          INTEGER NOT NULL,
  topics           TEXT NOT NULL,
  data             TEXT NOT NULL,
  payload          TEXT,
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
  encrypted_secret TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  event_filter     TEXT NOT NULL DEFAULT '[]',
  retry_policy     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL REFERENCES events(id),
  endpoint_id          TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT,
  last_response_status INTEGER,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS deliveries_event ON webhook_deliveries (event_id);
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

CREATE TABLE IF NOT EXISTS automation_rules (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  trigger_event_name  TEXT,
  trigger_contract    TEXT,
  endpoint_id         TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  metadata    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_project_time ON audit_logs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id         SERIAL PRIMARY KEY,
  project_id TEXT,
  level      TEXT NOT NULL,
  area       TEXT NOT NULL,
  message    TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_project_time ON logs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS service_status (
  name        TEXT PRIMARY KEY,
  updated_at  TEXT NOT NULL,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_project ON api_keys (project_id);

CREATE TABLE IF NOT EXISTS test_receivers (
  id          TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL UNIQUE REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  mode        TEXT NOT NULL DEFAULT 'ok',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receiver_requests (
  id               SERIAL PRIMARY KEY,
  receiver_id      TEXT NOT NULL REFERENCES test_receivers(id) ON DELETE CASCADE,
  received_at      TEXT NOT NULL,
  event_id         TEXT,
  delivery_id      TEXT,
  attempt          INTEGER,
  signature_ok     INTEGER NOT NULL,
  signature_reason TEXT,
  outcome          TEXT NOT NULL,
  http_status      INTEGER NOT NULL,
  body_preview     TEXT
);
CREATE INDEX IF NOT EXISTS receiver_requests_recv ON receiver_requests (receiver_id, id DESC);
