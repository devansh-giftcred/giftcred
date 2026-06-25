-- GiftCred Auth: TOTP MFA & recovery codes
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(128),
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recovery_codes JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_users_mfa_enabled ON users(mfa_enabled) WHERE mfa_enabled = TRUE;

COMMIT;
