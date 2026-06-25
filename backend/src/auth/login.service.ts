import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { enforceIpAllowlist } from "./account-access.service.js";
import { query } from "../db.js";
import { AuthError } from "../lib/errors.js";
import { invalidateRoleCache, resolveUserRole, type CachedRoleContext } from "../redis/roleCache.js";
import type { AuthContext } from "../types/auth.js";
import { generateSecureToken, normalizeEmail } from "./crypto.utils.js";
import { issueTokenPair, signMfaPendingToken } from "./jwt.service.js";
import { issueSessionTokens } from "./login.helpers.js";
import { verifyPassword } from "./password.service.js";
import { findActiveSessionByToken, rotateSession, revokeSession } from "./session.service.js";

export { AuthError } from "../lib/errors.js";
export { hashPassword } from "./password.service.js";

type LoginUserRow = {
  id: number;
  email: string;
  password_hash: string | null;
  account_id: number;
  role_id: number;
  status: string;
  mfa_enabled: boolean;
  account_type: "platform" | "master" | "child";
  mfa_enforced: boolean;
  sso_enforced: boolean;
};

function isMfaEnforcementActive(
  accountType: "platform" | "master" | "child",
  mfaEnforced: boolean
): boolean {
  return accountType === "platform" || mfaEnforced;
}

export async function loginWithPassword(
  client: PoolClient,
  email: string,
  password: string,
  meta: { ipAddress?: string; userAgent?: string }
) {
  const normalized = normalizeEmail(email);
  const result = await client.query<LoginUserRow>(
    `SELECT u.id, u.email, u.password_hash, u.account_id, u.role_id, u.status, u.mfa_enabled,
            a.account_type, COALESCE(a.mfa_enforced, FALSE) AS mfa_enforced,
            COALESCE(a.sso_enforced, FALSE) AS sso_enforced
     FROM users u
     JOIN accounts a ON a.id = u.account_id
     WHERE u.email = $1`,
    [normalized]
  );
  const user = result.rows[0];

  if (!user?.password_hash) {
    await writeAuditLog(client, {
      action: AuditAction.LOGIN_FAILED,
      newValue: { email: normalized, reason: "user_not_found" },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    throw new AuthError("Invalid email or password.", 401);
  }

  if (user.status !== "active") {
    throw new AuthError("Account is not active.", 403);
  }

  if (user.account_type !== "platform" && user.sso_enforced) {
    throw new AuthError(
      "Your organization requires SSO login. Please log in with Google or Microsoft.",
      403
    );
  }

  await enforceIpAllowlist(client, user.account_id, meta.ipAddress, {
    actingUserId: user.id,
    userAgent: meta.userAgent,
    email: user.email,
  });

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await writeAuditLog(client, {
      actingUserId: user.id,
      accountId: user.account_id,
      action: AuditAction.LOGIN_FAILED,
      newValue: { reason: "invalid_password" },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    throw new AuthError("Invalid email or password.", 401);
  }

  await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
  await invalidateRoleCache(user.id);

  const role = await resolveUserRole(user.id);
  if (!role) throw new AuthError("Unable to resolve user role.", 500);

  if (user.mfa_enabled) {
    const mfaToken = signMfaPendingToken({
      sub: user.id,
      email: user.email,
      accountId: user.account_id,
      roleId: user.role_id,
    });
    return {
      mfa_required: true as const,
      mfaToken,
      user: buildAuthContext(user.email, role),
    };
  }

  const loginResult = await completeLogin(client, user, role, meta, "password");
  const mfaSetupRequired =
    !user.mfa_enabled &&
    isMfaEnforcementActive(user.account_type, user.mfa_enforced);

  return {
    ...loginResult,
    ...(mfaSetupRequired ? { mfa_setup_required: true as const } : {}),
  };
}

export async function completeLoginAfterMfa(
  client: PoolClient,
  userId: number,
  meta: { ipAddress?: string; userAgent?: string }
) {
  const result = await client.query<LoginUserRow>(
    `SELECT id, email, account_id, role_id, status, mfa_enabled, password_hash FROM users WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user || user.status !== "active") throw new AuthError("Account is not active.", 403);

  const role = await resolveUserRole(user.id);
  if (!role) throw new AuthError("Unable to resolve user role.", 500);

  return completeLogin(client, user, role, meta, "password+mfa");
}

async function completeLogin(
  client: PoolClient,
  user: Pick<LoginUserRow, "id" | "email" | "account_id" | "role_id">,
  role: CachedRoleContext,
  meta: { ipAddress?: string; userAgent?: string },
  method: string
) {
  const { tokens, sessionId } = await issueSessionTokens(
    client,
    {
      id: user.id,
      email: user.email,
      account_id: user.account_id,
      role_id: user.role_id,
    },
    { roleSlug: role.roleSlug, privileges: role.privileges },
    meta
  );

  await writeAuditLog(client, {
    actingUserId: user.id,
    accountId: user.account_id,
    action: AuditAction.LOGIN_SUCCESS,
    newValue: { method, sessionId },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return { tokens, user: buildAuthContext(user.email, role) };
}

export async function refreshAccessToken(
  client: PoolClient,
  refreshToken: string,
  meta: { ipAddress?: string; userAgent?: string }
) {
  const session = await findActiveSessionByToken(client, refreshToken);
  if (!session) throw new AuthError("Session expired or revoked.", 401);

  const userResult = await client.query<{
    id: number;
    email: string;
    account_id: number;
    role_id: number;
    status: string;
  }>(`SELECT id, email, account_id, role_id, status FROM users WHERE id = $1`, [session.user_id]);

  const user = userResult.rows[0];
  if (!user || user.status !== "active") throw new AuthError("Account is not active.", 403);

  const role = await resolveUserRole(user.id);
  if (!role) throw new AuthError("Unable to resolve user role.", 500);

  const newRefreshToken = generateSecureToken(48);
  const newSessionId = await rotateSession(client, session.id, user.id, newRefreshToken, meta);
  const tokens = issueTokenPair(
    user.id,
    user.email,
    user.account_id,
    user.role_id,
    { roleSlug: role.roleSlug, privileges: role.privileges },
    newRefreshToken,
    newSessionId
  );

  return { tokens, userId: user.id };
}

export async function logout(
  client: PoolClient,
  sessionId: number,
  actingUserId: number,
  accountId: number,
  meta: { ipAddress?: string; userAgent?: string }
) {
  await revokeSession(client, sessionId);
  await invalidateRoleCache(actingUserId);
  await writeAuditLog(client, {
    actingUserId,
    accountId,
    action: AuditAction.LOGOUT,
    newValue: { sessionId },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}

export async function getUserEmail(userId: number): Promise<string | null> {
  const result = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.email ?? null;
}

function buildAuthContext(email: string, role: CachedRoleContext | null): AuthContext | null {
  if (!role) return null;
  const mfaEnforcementActive =
    role.accountType === "platform" || role.accountMfaEnforced;
  return {
    userId: role.userId,
    email,
    accountId: role.accountId,
    accountType: role.accountType,
    roleId: role.roleId,
    roleSlug: role.roleSlug,
    privileges: role.privileges,
    isPlatformAdmin: role.isPlatformAdmin,
    mfaEnabled: role.mfaEnabled,
    mfaEnforcementActive,
    ipAllowlist: role.ipAllowlist,
  };
}

export async function buildAuthContextForUser(userId: number): Promise<AuthContext | null> {
  const email = await getUserEmail(userId);
  if (!email) return null;
  const role = await resolveUserRole(userId);
  return buildAuthContext(email, role);
}
