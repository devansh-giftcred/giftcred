import type { PoolClient } from "pg";
import type { AuditActionType } from "./actions.js";
import type { AuthContext } from "../types/auth.js";
import { getScopedAccountIds, accountIdsPlaceholders } from "../lib/accountScope.js";

export interface AuditLogInput {
  actingUserId?: number | null;
  targetUserId?: number | null;
  accountId?: number | null;
  action: AuditActionType;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditLogFilters {
  page?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
  action?: string;
  actingUserId?: number;
}

export async function writeAuditLog(
  client: PoolClient,
  input: AuditLogInput
): Promise<void> {
  await client.query(
    `
    INSERT INTO audit_logs (
      acting_user_id, target_user_id, account_id,
      action, old_value, new_value, ip_address, user_agent, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      input.actingUserId ?? null,
      input.targetUserId ?? null,
      input.accountId ?? null,
      input.action,
      input.oldValue ? JSON.stringify(input.oldValue) : null,
      input.newValue ? JSON.stringify(input.newValue) : null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

export async function queryAuditLogs(
  client: PoolClient,
  auth: AuthContext,
  filters: AuditLogFilters
) {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
  const offset = (page - 1) * limit;

  const scopedAccountIds = await getScopedAccountIds(client, auth);
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (scopedAccountIds) {
    conditions.push(`account_id IN (${accountIdsPlaceholders(scopedAccountIds, paramIndex)})`);
    params.push(...scopedAccountIds);
    paramIndex += scopedAccountIds.length;
  }

  if (filters.startDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    params.push(filters.endDate);
  }
  if (filters.action) {
    conditions.push(`action = $${paramIndex++}`);
    params.push(filters.action);
  }
  if (filters.actingUserId) {
    conditions.push(`acting_user_id = $${paramIndex++}`);
    params.push(filters.actingUserId);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_logs ${whereClause}`,
    params
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const rowsResult = await client.query(
    `
    SELECT
      id, acting_user_id, target_user_id, account_id,
      action, old_value, new_value, ip_address, user_agent, metadata, created_at
    FROM audit_logs
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `,
    [...params, limit, offset]
  );

  return {
    logs: rowsResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}
