import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";

export async function createMasterAccount(
  client: PoolClient,
  input: { name: string; actingUserId?: number; ipAddress?: string }
) {
  const result = await client.query<{ id: number; name: string; account_type: string }>(
    `
    INSERT INTO accounts (name, account_type, status)
    VALUES ($1, 'master', 'active')
    RETURNING id, name, account_type
    `,
    [input.name]
  );
  const account = result.rows[0];

  await writeAuditLog(client, {
    actingUserId: input.actingUserId ?? null,
    accountId: account.id,
    action: AuditAction.ACCOUNT_CREATED,
    newValue: { name: account.name, accountType: account.account_type },
    ipAddress: input.ipAddress ?? null,
  });

  return account;
}

export async function createChildAccount(
  client: PoolClient,
  input: {
    masterAccountId: number;
    name: string;
    actingUserId: number;
    ipAddress?: string;
  }
) {
  const result = await client.query<{ id: number; name: string; account_type: string; parent_account_id: number }>(
    `
    INSERT INTO accounts (name, account_type, parent_account_id, status)
    VALUES ($1, 'child', $2, 'active')
    RETURNING id, name, account_type, parent_account_id
    `,
    [input.name, input.masterAccountId]
  );
  const account = result.rows[0];

  await writeAuditLog(client, {
    actingUserId: input.actingUserId,
    accountId: account.id,
    action: AuditAction.ACCOUNT_CREATED,
    newValue: {
      name: account.name,
      accountType: account.account_type,
      parentAccountId: account.parent_account_id,
    },
    ipAddress: input.ipAddress ?? null,
  });

  return account;
}

export async function listAccountsInScope(
  client: PoolClient,
  auth: { accountId: number; accountType: string; isPlatformAdmin: boolean }
) {
  if (auth.isPlatformAdmin) {
    const result = await client.query(
      `SELECT id, name, account_type, parent_account_id, status, created_at FROM accounts ORDER BY created_at DESC`
    );
    return result.rows;
  }

  if (auth.accountType === "master") {
    const result = await client.query(
      `
      SELECT id, name, account_type, parent_account_id, status, created_at
      FROM accounts
      WHERE id = $1 OR parent_account_id = $1
      ORDER BY created_at DESC
      `,
      [auth.accountId]
    );
    return result.rows;
  }

  const result = await client.query(
    `SELECT id, name, account_type, parent_account_id, status, created_at FROM accounts WHERE id = $1`,
    [auth.accountId]
  );
  return result.rows;
}

export async function getAccountById(client: PoolClient, accountId: number) {
  const result = await client.query(
    `SELECT id, name, account_type, parent_account_id, status, metadata, created_at FROM accounts WHERE id = $1`,
    [accountId]
  );
  return result.rows[0] ?? null;
}
