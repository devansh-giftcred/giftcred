-- BMS: Multi-Tenant Balance Management System (Double-Entry Ledger)
BEGIN;

CREATE TABLE bms_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    owner_type VARCHAR(50) NOT NULL CHECK (owner_type IN ('user', 'account')),
    owner_id BIGINT NOT NULL,
    account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    currency_code CHAR(3) NOT NULL,
    ledger_balance BIGINT NOT NULL DEFAULT 0,
    held_balance BIGINT NOT NULL DEFAULT 0,
    available_balance BIGINT GENERATED ALWAYS AS (ledger_balance - held_balance) STORED,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bms_accounts_tenant ON bms_accounts(tenant_id);
CREATE INDEX idx_bms_accounts_owner ON bms_accounts(owner_type, owner_id);
CREATE UNIQUE INDEX idx_bms_accounts_user_wallet
  ON bms_accounts(tenant_id, owner_type, owner_id, currency_code)
  WHERE owner_type = 'user' AND status = 'ACTIVE';

CREATE TABLE bms_journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    accounting_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bms_journal_entries_tenant ON bms_journal_entries(tenant_id);

CREATE TABLE bms_ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES bms_journal_entries(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES bms_accounts(id) ON DELETE RESTRICT,
    entry_type VARCHAR(6) NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency_code CHAR(3) NOT NULL,
    balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bms_ledger_entries_journal ON bms_ledger_entries(journal_entry_id);
CREATE INDEX idx_bms_ledger_entries_account ON bms_ledger_entries(account_id);

CREATE TABLE bms_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES bms_accounts(id) ON DELETE RESTRICT,
    journal_entry_id UUID REFERENCES bms_journal_entries(id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    status VARCHAR(50) NOT NULL CHECK (status IN ('ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED')),
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    ttl_expires_at TIMESTAMPTZ NOT NULL,
    order_reference VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bms_holds_account_status ON bms_holds(account_id, status);

COMMIT;
