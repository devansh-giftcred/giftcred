import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AuthError } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "./password.service.js";
import { invalidateRoleCache } from "../redis/roleCache.js";

export async function changePassword(
  client: PoolClient,
  userId: number,
  accountId: number,
  currentPassword: string,
  newPassword: string,
  meta: { ipAddress?: string; userAgent?: string }
): Promise<void> {
  const result = await client.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user?.password_hash) {
    throw new AuthError("Password login is not configured for this account.", 400);
  }

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    throw new AuthError("Current password is incorrect.", 401);
  }

  const newHash = await hashPassword(newPassword);
  await client.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
    newHash,
    userId,
  ]);

  await invalidateRoleCache(userId);
  await writeAuditLog(client, {
    actingUserId: userId,
    accountId,
    action: AuditAction.PASSWORD_CHANGED,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}
