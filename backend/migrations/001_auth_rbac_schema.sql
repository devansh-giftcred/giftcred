-- GiftCred Auth + RBAC Schema
-- PostgreSQL 14+
-- Run: psql $DATABASE_URL -f migrations/001_auth_rbac_schema.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions & enums
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_type AS ENUM ('platform', 'master', 'child');

CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deactivated');

CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');

CREATE TYPE otp_purpose AS ENUM ('login', 'verify_email', 'password_reset');

CREATE TYPE oauth_provider AS ENUM ('google', 'microsoft');

CREATE TYPE audit_action AS ENUM (
  'user_created',
  'user_updated',
  'user_suspended',
  'user_activated',
  'role_assigned',
  'role_changed',
  'role_created',
  'role_updated',
  'privilege_granted',
  'privilege_revoked',
  'invite_sent',
  'invite_accepted',
  'invite_revoked',
  'invite_expired',
  'session_created',
  'session_revoked',
  'login_success',
  'login_failed',
  'logout',
  'otp_sent',
  'otp_verified',
  'sso_linked',
  'account_created',
  'account_updated',
  'password_changed'
);

-- ---------------------------------------------------------------------------
-- Accounts (platform → master → child hierarchy)
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id              BIGSERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  account_type    account_type NOT NULL,
  parent_account_id BIGINT REFERENCES accounts(id) ON DELETE RESTRICT,
  status          VARCHAR(32) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'archived')),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounts_parent_type_check CHECK (
    (account_type = 'platform' AND parent_account_id IS NULL)
    OR (account_type = 'master' AND parent_account_id IS NULL)
    OR (account_type = 'child' AND parent_account_id IS NOT NULL)
  )
);

CREATE INDEX idx_accounts_parent ON accounts(parent_account_id);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE INDEX idx_accounts_status ON accounts(status);

-- ---------------------------------------------------------------------------
-- Privileges & roles (DB-driven RBAC)
-- ---------------------------------------------------------------------------

CREATE TABLE privileges (
  id          BIGSERIAL PRIMARY KEY,
  code        VARCHAR(64) NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  module      VARCHAR(64) NOT NULL DEFAULT 'general',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE roles (
  id              BIGSERIAL PRIMARY KEY,
  account_id      BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  slug            VARCHAR(64) NOT NULL,
  name            VARCHAR(128) NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  is_system       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT roles_slug_scope_unique UNIQUE (account_id, slug)
);

CREATE INDEX idx_roles_account ON roles(account_id);
CREATE UNIQUE INDEX roles_system_slug_unique ON roles(slug) WHERE account_id IS NULL;

CREATE TABLE role_privileges (
  role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  privilege_id  BIGINT NOT NULL REFERENCES privileges(id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, privilege_id)
);

CREATE INDEX idx_role_privileges_privilege ON role_privileges(privilege_id);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                BIGSERIAL PRIMARY KEY,
  account_id        BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  role_id           BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  email             VARCHAR(255) NOT NULL,
  password_hash     VARCHAR(255),
  first_name        VARCHAR(128) NOT NULL DEFAULT '',
  last_name         VARCHAR(128) NOT NULL DEFAULT '',
  status            user_status NOT NULL DEFAULT 'pending',
  email_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX idx_users_account ON users(account_id);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_status ON users(status);

-- ---------------------------------------------------------------------------
-- Sessions (refresh token rotation)
-- ---------------------------------------------------------------------------

CREATE TABLE user_sessions (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  VARCHAR(128) NOT NULL UNIQUE,
  device_info         JSONB NOT NULL DEFAULT '{}',
  ip_address          INET,
  user_agent          TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  replaced_by_id      BIGINT REFERENCES user_sessions(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_active ON user_sessions(user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Email OTP
-- ---------------------------------------------------------------------------

CREATE TABLE email_otps (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,
  code_hash   VARCHAR(128) NOT NULL,
  purpose     otp_purpose NOT NULL DEFAULT 'login',
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_otps_email ON email_otps(email);
CREATE INDEX idx_email_otps_active ON email_otps(email, purpose)
  WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- SSO identities (Google, Microsoft)
-- ---------------------------------------------------------------------------

CREATE TABLE user_oauth_identities (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          oauth_provider NOT NULL,
  provider_user_id  VARCHAR(255) NOT NULL,
  provider_email    VARCHAR(255) NOT NULL,
  profile           JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_oauth_provider_unique UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_user_oauth_user ON user_oauth_identities(user_id);

-- ---------------------------------------------------------------------------
-- Invites (48h token expiry)
-- ---------------------------------------------------------------------------

CREATE TABLE user_invites (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_by_user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email               VARCHAR(255) NOT NULL,
  role_id             BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  token_hash          VARCHAR(128) NOT NULL UNIQUE,
  status              invite_status NOT NULL DEFAULT 'pending',
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ,
  accepted_user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_invites_account ON user_invites(account_id);
CREATE INDEX idx_user_invites_email ON user_invites(email);
CREATE INDEX idx_user_invites_pending ON user_invites(status)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Audit logs (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  acting_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  account_id      BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  action          audit_action NOT NULL,
  old_value       JSONB,
  new_value       JSONB,
  ip_address      INET,
  user_agent      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_account ON audit_logs(account_id);
CREATE INDEX idx_audit_logs_acting_user ON audit_logs(acting_user_id);
CREATE INDEX idx_audit_logs_target_user ON audit_logs(target_user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs table is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- ---------------------------------------------------------------------------
-- Seed: privileges
-- ---------------------------------------------------------------------------

INSERT INTO privileges (code, description, module) VALUES
  ('platform_admin',     'Full cross-tenant access (GiftCred super owner)', 'platform'),
  ('view_all_accounts',  'View all master and child accounts',              'platform'),
  ('manage_accounts',    'Create and manage child accounts',                'accounts'),
  ('view_accounts',      'View account details in scope',                   'accounts'),
  ('invite_user',        'Send user invitations',                           'users'),
  ('manage_users',       'Create, update, suspend users',                   'users'),
  ('view_users',         'View users in account scope',                     'users'),
  ('assign_roles',       'Assign roles to users',                           'users'),
  ('manage_roles',       'Create and edit custom roles',                    'roles'),
  ('view_roles',         'View roles and privileges',                       'roles'),
  ('manage_finance',     'Manage billing and finance settings',             'finance'),
  ('view_orders',        'View gift card orders',                           'orders'),
  ('place_orders',       'Place gift card orders',                          'orders'),
  ('view_reports',       'View analytics and reports',                      'reports'),
  ('view_audit_logs',    'View audit trail',                                'audit')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: platform account + system roles
-- ---------------------------------------------------------------------------

INSERT INTO accounts (name, account_type, status)
SELECT 'GiftCred Platform', 'platform', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM accounts WHERE account_type = 'platform'
);

-- System roles (account_id NULL = global templates usable by any account)
INSERT INTO roles (account_id, slug, name, description, is_system)
SELECT NULL, v.slug, v.name, v.description, TRUE
FROM (VALUES
  ('owner',   'Owner',   'Full access within account scope'),
  ('admin',   'Admin',   'Manage users and invitations'),
  ('finance', 'Finance', 'Finance and order visibility'),
  ('analyst', 'Analyst', 'Read-only analytics and reporting')
) AS v(slug, name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.account_id IS NULL AND r.slug = v.slug
);

-- Owner privileges
INSERT INTO role_privileges (role_id, privilege_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN privileges p
WHERE r.slug = 'owner' AND r.account_id IS NULL
  AND p.code IN (
    'manage_accounts', 'view_accounts', 'invite_user', 'manage_users', 'view_users',
    'assign_roles', 'manage_roles', 'view_roles', 'manage_finance',
    'view_orders', 'place_orders', 'view_reports', 'view_audit_logs'
  )
ON CONFLICT DO NOTHING;

-- Admin privileges
INSERT INTO role_privileges (role_id, privilege_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN privileges p
WHERE r.slug = 'admin' AND r.account_id IS NULL
  AND p.code IN (
    'manage_accounts', 'view_accounts', 'invite_user', 'manage_users',
    'view_users', 'assign_roles', 'view_roles', 'view_orders', 'view_reports'
  )
ON CONFLICT DO NOTHING;

-- Finance privileges
INSERT INTO role_privileges (role_id, privilege_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN privileges p
WHERE r.slug = 'finance' AND r.account_id IS NULL
  AND p.code IN ('view_accounts', 'manage_finance', 'view_orders', 'view_reports')
ON CONFLICT DO NOTHING;

-- Analyst privileges
INSERT INTO role_privileges (role_id, privilege_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN privileges p
WHERE r.slug = 'analyst' AND r.account_id IS NULL
  AND p.code IN ('view_accounts', 'view_orders', 'view_reports')
ON CONFLICT DO NOTHING;

-- Platform owner role (super owner — all privileges including platform_admin)
INSERT INTO roles (account_id, slug, name, description, is_system)
SELECT a.id, 'platform_owner', 'Platform Owner', 'GiftCred super owner with cross-tenant access', TRUE
FROM accounts a
WHERE a.account_type = 'platform'
  AND NOT EXISTS (
    SELECT 1 FROM roles r
    WHERE r.account_id = a.id AND r.slug = 'platform_owner'
  );

INSERT INTO role_privileges (role_id, privilege_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN privileges p
JOIN accounts a ON r.account_id = a.id
WHERE a.account_type = 'platform' AND r.slug = 'platform_owner'
ON CONFLICT DO NOTHING;

COMMIT;
