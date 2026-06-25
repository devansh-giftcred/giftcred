import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AuthError } from "../lib/errors.js";
import { invalidateRoleCache } from "../redis/roleCache.js";
import { clearSessionActivity, revokeSessionForUser } from "../auth/session.service.js";
import type { AuthContext } from "../types/auth.js";

export async function revokeUserSessionAsAdmin(
  client: PoolClient,
  actingUser: AuthContext,
  targetUserId: number,
  sessionId: number,
  meta: { ipAddress?: string; userAgent?: string }
): Promise<void> {
  const targetResult = await client.query<{ account_id: number }>(
    `SELECT account_id FROM users WHERE id = $1`,
    [targetUserId]
  );
  const target = targetResult.rows[0];
  if (!target) {
    throw new AuthError("User not found.", 404);
  }

  if (!actingUser.isPlatformAdmin && target.account_id !== actingUser.accountId) {
    throw new AuthError("Cannot revoke sessions for users outside your organization.", 403);
  }

  await revokeSessionForUser(client, targetUserId, sessionId);
  await clearSessionActivity(sessionId);
  await invalidateRoleCache(targetUserId);

  await writeAuditLog(client, {
    actingUserId: actingUser.userId,
    accountId: actingUser.accountId,
    targetUserId,
    action: AuditAction.SESSION_REVOKED_BY_ADMIN,
    newValue: { sessionId, targetUserId },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}
