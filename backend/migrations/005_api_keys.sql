-- Phase 2: B2B Partner API keys
BEGIN;

CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  key_hash    VARCHAR(128) NOT NULL,
  prefix      VARCHAR(8) NOT NULL,
  scopes      JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix_active
  ON api_keys(prefix) WHERE revoked_at IS NULL;

COMMIT;
