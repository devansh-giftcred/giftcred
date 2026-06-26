import type { PoolClient } from "pg";
import { ConcurrencyError, LedgerError } from "../lib/errors.js";
import { executeDoubleEntry, getAccountById } from "./ledger.service.js";
import type { BmsAccount } from "./types.js";

export interface BmsHold {
  id: string;
  account_id: string;
  journal_entry_id: string | null;
  amount: number;
  status: string;
  idempotency_key: string;
  ttl_expires_at: Date;
  order_reference: string;
  created_at: Date;
  updated_at: Date;
}

type HoldRow = {
  id: string;
  account_id: string;
  journal_entry_id: string | null;
  amount: string;
  status: string;
  idempotency_key: string;
  ttl_expires_at: Date;
  order_reference: string;
  created_at: Date;
  updated_at: Date;
};

function mapHold(row: HoldRow): BmsHold {
  return {
    id: row.id,
    account_id: row.account_id,
    journal_entry_id: row.journal_entry_id,
    amount: Number(row.amount),
    status: row.status,
    idempotency_key: row.idempotency_key,
    ttl_expires_at: row.ttl_expires_at,
    order_reference: row.order_reference,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function placeHold(
  client: PoolClient,
  accountId: string,
  amount: number,
  ttlMinutes: number,
  idempotencyKey: string,
  orderReference: string
): Promise<BmsHold> {
  const existing = await client.query<HoldRow>(
    `SELECT * FROM bms_holds WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    return mapHold(existing.rows[0]);
  }

  if (amount <= 0) {
    throw new LedgerError("Hold amount must be positive.", 400);
  }
  if (!orderReference.trim()) {
    throw new LedgerError("orderReference is required.", 400);
  }

  const accountResult = await client.query<{
    id: string;
    available_balance: string;
    version: string;
    status: string;
  }>(
    `
    SELECT id, available_balance, version, status
    FROM bms_accounts
    WHERE id = $1
    FOR UPDATE
    `,
    [accountId]
  );
  const account = accountResult.rows[0];
  if (!account) {
    throw new LedgerError("BMS account not found.", 404);
  }
  if (account.status !== "ACTIVE") {
    throw new LedgerError("BMS account is not active.", 400);
  }

  const available = Number(account.available_balance);
  if (available < amount) {
    throw new LedgerError("Insufficient available balance for hold.", 400);
  }

  const version = Number(account.version);
  const updateResult = await client.query(
    `
    UPDATE bms_accounts
    SET held_balance = held_balance + $1,
        version = version + 1,
        updated_at = NOW()
    WHERE id = $2 AND version = $3
    RETURNING id
    `,
    [amount, accountId, version]
  );
  if ((updateResult.rowCount ?? 0) === 0) {
    throw new ConcurrencyError();
  }

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + ttlMinutes);

  const holdResult = await client.query<HoldRow>(
    `
    INSERT INTO bms_holds (
      account_id, amount, status, idempotency_key, ttl_expires_at, order_reference
    ) VALUES ($1, $2, 'ACTIVE', $3, $4, $5)
    RETURNING *
    `,
    [accountId, amount, idempotencyKey, expiresAt.toISOString(), orderReference]
  );

  return mapHold(holdResult.rows[0]);
}

export async function captureHold(
  client: PoolClient,
  holdId: string,
  captureAmount: number,
  destinationAccountId: string,
  idempotencyKey: string
): Promise<{ hold: BmsHold; journalEntryId: string }> {
  const holdResult = await client.query<HoldRow>(
    `SELECT * FROM bms_holds WHERE id = $1 FOR UPDATE`,
    [holdId]
  );
  const hold = holdResult.rows[0];
  if (!hold) {
    throw new LedgerError("Hold not found.", 404);
  }
  if (hold.status !== "ACTIVE") {
    throw new LedgerError("Hold is not active.", 400);
  }
  if (captureAmount <= 0 || captureAmount > Number(hold.amount)) {
    throw new LedgerError("Invalid capture amount.", 400);
  }

  const accountResult = await client.query<{
    id: string;
    tenant_id: number;
    version: string;
    ledger_balance: string;
    held_balance: string;
    currency_code: string;
  }>(
    `SELECT id, tenant_id, version, ledger_balance, held_balance, currency_code
     FROM bms_accounts WHERE id = $1 FOR UPDATE`,
    [hold.account_id]
  );
  const account = accountResult.rows[0];
  if (!account) {
    throw new LedgerError("BMS account not found.", 404);
  }

  const holdAmount = Number(hold.amount);
  const version = Number(account.version);

  const updateResult = await client.query(
    `
    UPDATE bms_accounts
    SET held_balance = held_balance - $1,
        version = version + 1,
        updated_at = NOW()
    WHERE id = $2 AND version = $3
    RETURNING id
    `,
    [holdAmount, hold.account_id, version]
  );
  if ((updateResult.rowCount ?? 0) === 0) {
    throw new ConcurrencyError();
  }

  const journal = await executeDoubleEntry(client, {
    tenantId: account.tenant_id,
    idempotencyKey,
    description: `Hold capture for order ${hold.order_reference}`,
    entries: [
      { accountId: hold.account_id, amount: captureAmount, type: "DEBIT" },
      { accountId: destinationAccountId, amount: captureAmount, type: "CREDIT" },
    ],
  });

  const updatedHold = await client.query<HoldRow>(
    `
    UPDATE bms_holds
    SET status = 'CAPTURED',
        journal_entry_id = $2,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [holdId, journal.journalEntryId]
  );

  return {
    hold: mapHold(updatedHold.rows[0]),
    journalEntryId: journal.journalEntryId,
  };
}

export async function voidHold(client: PoolClient, holdId: string): Promise<BmsHold> {
  const holdResult = await client.query<HoldRow>(
    `SELECT * FROM bms_holds WHERE id = $1 FOR UPDATE`,
    [holdId]
  );
  const hold = holdResult.rows[0];
  if (!hold) {
    throw new LedgerError("Hold not found.", 404);
  }
  if (hold.status !== "ACTIVE") {
    throw new LedgerError("Hold is not active.", 400);
  }

  const accountResult = await client.query<{ version: string }>(
    `SELECT version FROM bms_accounts WHERE id = $1 FOR UPDATE`,
    [hold.account_id]
  );
  const account = accountResult.rows[0];
  if (!account) {
    throw new LedgerError("BMS account not found.", 404);
  }

  const holdAmount = Number(hold.amount);
  const version = Number(account.version);

  const updateResult = await client.query(
    `
    UPDATE bms_accounts
    SET held_balance = held_balance - $1,
        version = version + 1,
        updated_at = NOW()
    WHERE id = $2 AND version = $3
    RETURNING id
    `,
    [holdAmount, hold.account_id, version]
  );
  if ((updateResult.rowCount ?? 0) === 0) {
    throw new ConcurrencyError();
  }

  const updatedHold = await client.query<HoldRow>(
    `
    UPDATE bms_holds
    SET status = 'RELEASED', updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [holdId]
  );

  return mapHold(updatedHold.rows[0]);
}

export async function getHoldById(client: PoolClient, holdId: string): Promise<BmsHold | null> {
  const result = await client.query<HoldRow>(`SELECT * FROM bms_holds WHERE id = $1`, [holdId]);
  return result.rows[0] ? mapHold(result.rows[0]) : null;
}

export async function getAccountBalances(
  client: PoolClient,
  accountId: string
): Promise<BmsAccount | null> {
  return getAccountById(client, accountId);
}
