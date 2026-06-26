import type { PoolClient } from "pg";
import { ConcurrencyError, LedgerError } from "../lib/errors.js";
import type {
  BmsAccount,
  BmsAccountType,
  BmsEntryType,
  DoubleEntryInput,
  JournalEntryResult,
} from "./types.js";

export { ConcurrencyError, LedgerError } from "../lib/errors.js";

type AccountRow = {
  id: string;
  tenant_id: number;
  owner_type: string;
  owner_id: number;
  account_type: BmsAccountType;
  currency_code: string;
  ledger_balance: string;
  held_balance: string;
  available_balance: string;
  status: string;
  version: string;
  created_at: Date;
  updated_at: Date;
};

function mapAccount(row: AccountRow): BmsAccount {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    owner_type: row.owner_type as BmsAccount["owner_type"],
    owner_id: row.owner_id,
    account_type: row.account_type,
    currency_code: row.currency_code,
    ledger_balance: Number(row.ledger_balance),
    held_balance: Number(row.held_balance),
    available_balance: Number(row.available_balance),
    status: row.status,
    version: Number(row.version),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createWalletForUser(
  client: PoolClient,
  userId: number,
  tenantId: number,
  currency: string
): Promise<BmsAccount> {
  const existing = await client.query<AccountRow>(
    `
    SELECT id, tenant_id, owner_type, owner_id, account_type, currency_code,
           ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    FROM bms_accounts
    WHERE tenant_id = $1 AND owner_type = 'user' AND owner_id = $2 AND currency_code = $3 AND status = 'ACTIVE'
    `,
    [tenantId, userId, currency.toUpperCase()]
  );
  if (existing.rows[0]) {
    return mapAccount(existing.rows[0]);
  }

  const result = await client.query<AccountRow>(
    `
    INSERT INTO bms_accounts (tenant_id, owner_type, owner_id, account_type, currency_code)
    VALUES ($1, 'user', $2, 'ASSET', $3)
    RETURNING id, tenant_id, owner_type, owner_id, account_type, currency_code,
              ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    `,
    [tenantId, userId, currency.toUpperCase()]
  );
  return mapAccount(result.rows[0]);
}

export async function createTenantPoolAccount(
  client: PoolClient,
  tenantId: number,
  currency: string,
  accountType: BmsAccountType = "LIABILITY"
): Promise<BmsAccount> {
  const existing = await client.query<AccountRow>(
    `
    SELECT id, tenant_id, owner_type, owner_id, account_type, currency_code,
           ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    FROM bms_accounts
    WHERE tenant_id = $1 AND owner_type = 'account' AND owner_id = $1 AND currency_code = $2 AND status = 'ACTIVE'
    `,
    [tenantId, currency.toUpperCase()]
  );
  if (existing.rows[0]) {
    return mapAccount(existing.rows[0]);
  }

  const result = await client.query<AccountRow>(
    `
    INSERT INTO bms_accounts (tenant_id, owner_type, owner_id, account_type, currency_code)
    VALUES ($1, 'account', $1, $2, $3)
    RETURNING id, tenant_id, owner_type, owner_id, account_type, currency_code,
              ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    `,
    [tenantId, accountType, currency.toUpperCase()]
  );
  return mapAccount(result.rows[0]);
}

export async function getAccountById(
  client: PoolClient,
  accountId: string,
  forUpdate = false
): Promise<BmsAccount | null> {
  const lock = forUpdate ? "FOR UPDATE" : "";
  const result = await client.query<AccountRow>(
    `
    SELECT id, tenant_id, owner_type, owner_id, account_type, currency_code,
           ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    FROM bms_accounts
    WHERE id = $1
    ${lock}
    `,
    [accountId]
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

export async function getWalletsForUser(
  client: PoolClient,
  userId: number,
  tenantId: number
): Promise<BmsAccount[]> {
  const result = await client.query<AccountRow>(
    `
    SELECT id, tenant_id, owner_type, owner_id, account_type, currency_code,
           ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    FROM bms_accounts
    WHERE owner_type = 'user' AND owner_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
    ORDER BY currency_code ASC
    `,
    [userId, tenantId]
  );
  return result.rows.map(mapAccount);
}

async function getAccountForEntry(
  client: PoolClient,
  accountId: string
): Promise<BmsAccount> {
  const account = await getAccountById(client, accountId, false);
  if (!account) {
    throw new LedgerError("BMS account not found.", 404);
  }
  if (account.status !== "ACTIVE") {
    throw new LedgerError("BMS account is not active.", 400);
  }
  return account;
}

async function applyBalanceUpdate(
  client: PoolClient,
  account: BmsAccount,
  entryType: BmsEntryType,
  amount: number
): Promise<BmsAccount> {
  if (
    entryType === "DEBIT" &&
    account.account_type === "ASSET" &&
    account.owner_type === "user" &&
    account.ledger_balance < amount
  ) {
    throw new LedgerError("Insufficient ledger balance.", 400);
  }

  const delta = entryType === "CREDIT" ? amount : -amount;
  const result = await client.query<AccountRow>(
    `
    UPDATE bms_accounts
    SET ledger_balance = ledger_balance + $1,
        version = version + 1,
        updated_at = NOW()
    WHERE id = $2 AND version = $3
    RETURNING id, tenant_id, owner_type, owner_id, account_type, currency_code,
              ledger_balance, held_balance, available_balance, status, version, created_at, updated_at
    `,
    [delta, account.id, account.version]
  );

  if (!result.rows[0]) {
    throw new ConcurrencyError();
  }

  const updated = mapAccount(result.rows[0]);
  if (
    updated.account_type === "ASSET" &&
    updated.owner_type === "user" &&
    updated.ledger_balance < 0
  ) {
    throw new LedgerError("Insufficient ledger balance.", 400);
  }
  return updated;
}

export async function executeDoubleEntry(
  client: PoolClient,
  input: DoubleEntryInput
): Promise<JournalEntryResult> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM bms_journal_entries WHERE idempotency_key = $1`,
    [input.idempotencyKey]
  );
  if (existing.rows[0]) {
    const legs = await client.query<{ id: string }>(
      `SELECT id FROM bms_ledger_entries WHERE journal_entry_id = $1 ORDER BY created_at ASC`,
      [existing.rows[0].id]
    );
    return {
      journalEntryId: existing.rows[0].id,
      ledgerEntryIds: legs.rows.map((row) => row.id),
    };
  }

  if (!input.entries.length) {
    throw new LedgerError("At least one ledger entry is required.", 400);
  }

  const totalDebits = input.entries
    .filter((e) => e.type === "DEBIT")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalCredits = input.entries
    .filter((e) => e.type === "CREDIT")
    .reduce((sum, e) => sum + e.amount, 0);

  if (totalDebits !== totalCredits) {
    throw new LedgerError(
      `Unbalanced journal entry: debits (${totalDebits}) must equal credits (${totalCredits}).`,
      400
    );
  }

  if (totalDebits === 0) {
    throw new LedgerError("Journal entry amount must be greater than zero.", 400);
  }

  const journalResult = await client.query<{ id: string }>(
    `
    INSERT INTO bms_journal_entries (tenant_id, idempotency_key, description)
    VALUES ($1, $2, $3)
    RETURNING id
    `,
    [input.tenantId, input.idempotencyKey, input.description ?? null]
  );
  const journalEntryId = journalResult.rows[0].id;

  const accountIds = [...new Set(input.entries.map((e) => e.accountId))];
  const lockedAccounts = new Map<string, BmsAccount>();
  for (const accountId of accountIds) {
    lockedAccounts.set(accountId, await getAccountForEntry(client, accountId));
  }

  const ledgerEntryIds: string[] = [];

  for (const entry of input.entries) {
    const account = lockedAccounts.get(entry.accountId)!;
    if (account.tenant_id !== input.tenantId) {
      throw new LedgerError("All accounts must belong to the same tenant.", 400);
    }
    if (entry.amount <= 0) {
      throw new LedgerError("Entry amount must be positive.", 400);
    }

    const updated = await applyBalanceUpdate(client, account, entry.type, entry.amount);
    lockedAccounts.set(entry.accountId, updated);

    const legResult = await client.query<{ id: string }>(
      `
      INSERT INTO bms_ledger_entries (
        journal_entry_id, account_id, entry_type, amount, currency_code, balance_after
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [
        journalEntryId,
        entry.accountId,
        entry.type,
        entry.amount,
        updated.currency_code,
        updated.ledger_balance,
      ]
    );
    ledgerEntryIds.push(legResult.rows[0].id);
  }

  return { journalEntryId, ledgerEntryIds };
}

export async function fundWallet(
  client: PoolClient,
  tenantId: number,
  walletAccountId: string,
  poolAccountId: string,
  amount: number,
  idempotencyKey: string
): Promise<JournalEntryResult> {
  return executeDoubleEntry(client, {
    tenantId,
    idempotencyKey,
    description: "Wallet funding",
    entries: [
      { accountId: walletAccountId, amount, type: "CREDIT" },
      { accountId: poolAccountId, amount, type: "DEBIT" },
    ],
  });
}
