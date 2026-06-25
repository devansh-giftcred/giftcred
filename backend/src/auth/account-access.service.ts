import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AuthError } from "../lib/errors.js";
import { isIpAllowed, parseIpAllowlist } from "../lib/ipUtils.js";

export async function enforceIpAllowlist(
  client: PoolClient,
  accountId: number,
  clientIp: string | undefined,
  audit: { actingUserId?: number; userAgent?: string; email?: string }
): Promise<void> {
  const ip = clientIp?.trim() || "0.0.0.0";
  const result = await client.query<{ ip_allowlist: unknown }>(
    `SELECT COALESCE(ip_allowlist, '[]'::jsonb) AS ip_allowlist FROM accounts WHERE id = $1`,
    [accountId]
  );
  const allowlist = parseIpAllowlist(result.rows[0]?.ip_allowlist);
  if (isIpAllowed(ip, allowlist)) return;

  await writeAuditLog(client, {
    actingUserId: audit.actingUserId,
    accountId,
    action: AuditAction.LOGIN_FAILED,
    newValue: { reason: "ip_not_allowed", email: audit.email, clientIp: ip },
    ipAddress: ip,
    userAgent: audit.userAgent,
  });
  throw new AuthError("Access denied from this IP address.", 403);
}
