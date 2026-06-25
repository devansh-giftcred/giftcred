import type { PoolClient } from "pg";
import type { AuthContext } from "../types/auth.js";

/** Returns null when the caller may access all accounts (platform admin). */
export async function getScopedAccountIds(
  client: PoolClient,
  auth: Pick<AuthContext, "accountId" | "accountType" | "isPlatformAdmin">
): Promise<number[] | null> {
  if (auth.isPlatformAdmin) return null;

  if (auth.accountType === "master") {
    const result = await client.query<{ id: number }>(
      `SELECT id FROM accounts WHERE id = $1 OR parent_account_id = $1`,
      [auth.accountId]
    );
    return result.rows.map((row) => row.id);
  }

  return [auth.accountId];
}

export function accountIdsPlaceholders(accountIds: number[], startIndex = 1): string {
  return accountIds.map((_, i) => `$${startIndex + i}`).join(", ");
}
