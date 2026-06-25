import bcrypt from "bcrypt";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AuthError } from "../lib/errors.js";
import { invalidateRoleCache } from "../redis/roleCache.js";
import { generateSecureToken } from "./crypto.utils.js";

const RECOVERY_CODE_COUNT = 10;
const APP_NAME = "GiftCred";

authenticator.options = { window: 1 };

function generateRecoveryCode(): string {
  const part = () => generateSecureToken(4).slice(0, 4).toUpperCase();
  return `${part()}-${part()}`;
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

export async function setupMfa(
  client: PoolClient,
  userId: number,
  email: string
): Promise<{ qrCodeDataUrl: string; otpauthUrl: string }> {
  const secret = authenticator.generateSecret();

  await client.query(
    `
    UPDATE users
    SET totp_secret = $1, mfa_enabled = FALSE, recovery_codes = '[]'::jsonb, updated_at = NOW()
    WHERE id = $2
    `,
    [secret, userId]
  );

  const otpauthUrl = authenticator.keyuri(email, APP_NAME, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  return { qrCodeDataUrl, otpauthUrl };
}

export async function enableMfa(
  client: PoolClient,
  userId: number,
  totpCode: string,
  meta: { ipAddress?: string; userAgent?: string; accountId: number }
): Promise<{ recoveryCodes: string[] }> {
  const result = await client.query<{
    totp_secret: string | null;
    mfa_enabled: boolean;
  }>(`SELECT totp_secret, mfa_enabled FROM users WHERE id = $1`, [userId]);

  const user = result.rows[0];
  if (!user?.totp_secret) {
    throw new AuthError("MFA setup not started. Call /api/auth/mfa/setup first.", 400);
  }
  if (user.mfa_enabled) {
    throw new AuthError("MFA is already enabled.", 400);
  }

  const valid = authenticator.verify({ token: totpCode, secret: user.totp_secret });
  if (!valid) throw new AuthError("Invalid TOTP code.", 400);

  const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const hashedCodes = await Promise.all(plainCodes.map((code) => bcrypt.hash(code, 10)));

  await client.query(
    `
    UPDATE users
    SET mfa_enabled = TRUE, recovery_codes = $1::jsonb, updated_at = NOW()
    WHERE id = $2
    `,
    [JSON.stringify(hashedCodes), userId]
  );

  await invalidateRoleCache(userId);

  await writeAuditLog(client, {
    actingUserId: userId,
    accountId: meta.accountId,
    action: AuditAction.USER_UPDATED,
    newValue: { mfa_enabled: true },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return { recoveryCodes: plainCodes };
}

export async function verifyMfaForLogin(
  client: PoolClient,
  userId: number,
  input: { totpCode?: string; recoveryCode?: string }
): Promise<"totp" | "recovery"> {
  const result = await client.query<{
    totp_secret: string | null;
    mfa_enabled: boolean;
    recovery_codes: string[];
  }>(
    `SELECT totp_secret, mfa_enabled, recovery_codes FROM users WHERE id = $1`,
    [userId]
  );

  const user = result.rows[0];
  if (!user?.mfa_enabled || !user.totp_secret) {
    throw new AuthError("MFA is not enabled for this account.", 400);
  }

  if (input.totpCode) {
    const valid = authenticator.verify({ token: input.totpCode, secret: user.totp_secret });
    if (!valid) throw new AuthError("Invalid TOTP code.", 401);
    return "totp";
  }

  if (input.recoveryCode) {
    const normalized = normalizeRecoveryCode(input.recoveryCode);
    const hashes = Array.isArray(user.recovery_codes) ? user.recovery_codes : [];
    let matchIndex = -1;

    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i];
      if (typeof hash === "string" && (await bcrypt.compare(normalized, hash))) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex < 0) throw new AuthError("Invalid recovery code.", 401);

    const remaining = hashes.filter((_, i) => i !== matchIndex);
    await client.query(`UPDATE users SET recovery_codes = $1::jsonb, updated_at = NOW() WHERE id = $2`, [
      JSON.stringify(remaining),
      userId,
    ]);

    return "recovery";
  }

  throw new AuthError("TOTP code or recovery code is required.", 400);
}

export async function verifyStepUpMfa(
  client: PoolClient,
  userId: number,
  totpCode: string
): Promise<void> {
  await verifyMfaForLogin(client, userId, { totpCode });
}

export async function isMfaEnabled(client: PoolClient, userId: number): Promise<boolean> {
  const result = await client.query<{ mfa_enabled: boolean }>(
    `SELECT mfa_enabled FROM users WHERE id = $1`,
    [userId]
  );
  return Boolean(result.rows[0]?.mfa_enabled);
}
