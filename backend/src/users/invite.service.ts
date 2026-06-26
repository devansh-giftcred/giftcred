import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import type { AuthContext } from "../types/auth.js";
import { getScopedAccountIds, accountIdsPlaceholders } from "../lib/accountScope.js";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { config } from "../config.js";
import { invalidateRoleCache } from "../redis/roleCache.js";
import { generateSecureToken, hashToken, normalizeEmail } from "../auth/crypto.utils.js";
import { AuthError } from "../lib/errors.js";
import { hashPassword } from "../auth/password.service.js";
import { createWalletForUser } from "../ledger/ledger.service.js";

let transporter: nodemailer.Transporter | null = null;

function getMailer(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: config.gmailUser(),
        pass: config.gmailAppPassword(),
      },
    });
  }
  return transporter;
}

async function sendInviteEmail(to: string, inviteUrl: string): Promise<void> {
  await getMailer().sendMail({
    from: config.emailFrom(),
    to,
    subject: "You're invited to GiftCred",
    text: `You've been invited to join GiftCred. Accept your invite: ${inviteUrl}`,
    html: `<p>You've been invited to join GiftCred.</p><p><a href="${inviteUrl}">Accept invitation</a></p><p>This link expires in ${config.inviteTokenTtlHours()} hours.</p>`,
  });
}

export async function sendUserInvite(
  client: PoolClient,
  input: {
    accountId: number;
    invitedByUserId: number;
    email: string;
    roleId: number;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  const normalized = normalizeEmail(input.email);
  const rawToken = generateSecureToken(32);
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + config.inviteTokenTtlHours());

  const result = await client.query<{ id: number }>(
    `
    INSERT INTO user_invites (
      account_id, invited_by_user_id, email, role_id, token_hash, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
    `,
    [input.accountId, input.invitedByUserId, normalized, input.roleId, hashToken(rawToken), expiresAt.toISOString()]
  );

  const inviteUrl = `${config.frontendUrl()}/invite/accept?token=${encodeURIComponent(rawToken)}`;

  await sendInviteEmail(normalized, inviteUrl);

  await writeAuditLog(client, {
    actingUserId: input.invitedByUserId,
    accountId: input.accountId,
    action: AuditAction.INVITE_SENT,
    newValue: { email: normalized, roleId: input.roleId, inviteId: result.rows[0].id },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { inviteId: result.rows[0].id, expiresAt };
}

export async function acceptInvite(
  client: PoolClient,
  input: {
    token: string;
    password: string;
    firstName?: string;
    lastName?: string;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  const result = await client.query<{
    id: number;
    account_id: number;
    email: string;
    role_id: number;
    status: string;
    expires_at: Date;
  }>(
    `
    SELECT id, account_id, email, role_id, status, expires_at
    FROM user_invites
    WHERE token_hash = $1 AND status = 'pending'
    `,
    [hashToken(input.token)]
  );

  const invite = result.rows[0];
  if (!invite) throw new AuthError("Invalid or expired invite.", 400);
  if (new Date(invite.expires_at) < new Date()) {
    await client.query(`UPDATE user_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
    await writeAuditLog(client, {
      accountId: invite.account_id,
      action: AuditAction.INVITE_EXPIRED,
      newValue: { inviteId: invite.id, email: invite.email },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    throw new AuthError("Invite has expired.", 400);
  }

  const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [invite.email]);
  if (existing.rows[0]) throw new AuthError("A user with this email already exists.", 409);

  const passwordHash = await hashPassword(input.password);
  const userResult = await client.query<{ id: number }>(
    `
    INSERT INTO users (
      account_id, role_id, email, password_hash, first_name, last_name, status, email_verified_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
    RETURNING id
    `,
    [
      invite.account_id,
      invite.role_id,
      invite.email,
      passwordHash,
      input.firstName ?? "",
      input.lastName ?? "",
    ]
  );

  const userId = userResult.rows[0].id;

  await createWalletForUser(client, userId, invite.account_id, "INR");

  await client.query(
    `
    UPDATE user_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_user_id = $2
    WHERE id = $1
    `,
    [invite.id, userId]
  );

  await writeAuditLog(client, {
    actingUserId: userId,
    targetUserId: userId,
    accountId: invite.account_id,
    action: AuditAction.INVITE_ACCEPTED,
    newValue: { inviteId: invite.id, email: invite.email, roleId: invite.role_id },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  await writeAuditLog(client, {
    actingUserId: userId,
    targetUserId: userId,
    accountId: invite.account_id,
    action: AuditAction.USER_CREATED,
    newValue: { email: invite.email, source: "invite" },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { userId, email: invite.email, accountId: invite.account_id, roleId: invite.role_id };
}

export async function assignUserRole(
  client: PoolClient,
  input: {
    targetUserId: number;
    newRoleId: number;
    actingUserId: number;
    accountId: number;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  const current = await client.query<{ role_id: number }>(
    `SELECT role_id FROM users WHERE id = $1 AND account_id = $2`,
    [input.targetUserId, input.accountId]
  );
  const row = current.rows[0];
  if (!row) throw new AuthError("User not found in this account.", 404);

  await client.query(`UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2`, [
    input.newRoleId,
    input.targetUserId,
  ]);

  await invalidateRoleCache(input.targetUserId);

  await writeAuditLog(client, {
    actingUserId: input.actingUserId,
    targetUserId: input.targetUserId,
    accountId: input.accountId,
    action: AuditAction.ROLE_CHANGED,
    oldValue: { roleId: row.role_id },
    newValue: { roleId: input.newRoleId },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}

export async function listUsersInScopedAccounts(
  client: PoolClient,
  auth: Pick<AuthContext, "accountId" | "accountType" | "isPlatformAdmin">
) {
  const scopedAccountIds = await getScopedAccountIds(client, auth);

  if (scopedAccountIds === null) {
    const result = await client.query(
      `
      SELECT u.id, u.email, u.first_name, u.last_name, u.status, u.last_login_at,
             u.account_id, a.name AS account_name, a.account_type,
             r.id AS role_id, r.slug AS role_slug, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      JOIN accounts a ON a.id = u.account_id
      ORDER BY u.created_at DESC
      `
    );
    return result.rows;
  }

  const result = await client.query(
    `
    SELECT u.id, u.email, u.first_name, u.last_name, u.status, u.last_login_at,
           u.account_id, a.name AS account_name, a.account_type,
           r.id AS role_id, r.slug AS role_slug, r.name AS role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    JOIN accounts a ON a.id = u.account_id
    WHERE u.account_id IN (${accountIdsPlaceholders(scopedAccountIds)})
    ORDER BY u.created_at DESC
    `,
    scopedAccountIds
  );
  return result.rows;
}

export async function listUsersInAccount(client: PoolClient, accountId: number) {
  const result = await client.query(
    `
    SELECT u.id, u.email, u.first_name, u.last_name, u.status, u.last_login_at,
           r.id AS role_id, r.slug AS role_slug, r.name AS role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.account_id = $1
    ORDER BY u.created_at DESC
    `,
    [accountId]
  );
  return result.rows;
}

export async function listRoles(client: PoolClient, accountId?: number) {
  const result = await client.query(
    `
    SELECT id, account_id, slug, name, description, is_system
    FROM roles
    WHERE account_id IS NULL OR account_id = $1
    ORDER BY is_system DESC, name ASC
    `,
    [accountId ?? null]
  );
  return result.rows;
}
