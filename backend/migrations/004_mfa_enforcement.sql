-- Phase 2: Org-wide MFA enforcement
BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS mfa_enforced BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_accounts_mfa_enforced ON accounts (mfa_enforced)
  WHERE mfa_enforced = TRUE;

-- New audit action for admin-initiated session revocation
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'session_revoked_by_admin';

COMMIT;
