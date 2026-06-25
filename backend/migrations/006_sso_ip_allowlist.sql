-- Phase 3: SSO enforcement and IP allowlisting
BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sso_enforced BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ip_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_accounts_sso_enforced ON accounts (sso_enforced)
  WHERE sso_enforced = TRUE;

COMMIT;
