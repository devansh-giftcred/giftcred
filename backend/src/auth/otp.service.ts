import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { config } from "../config.js";
import { getRedis, isRedisReady, otpRateLimitKey } from "../redis/client.js";
import { generateOtpCode, hashToken, normalizeEmail } from "./crypto.utils.js";
import { AuthError } from "../lib/errors.js";

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

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  await getMailer().sendMail({
    from: config.emailFrom(),
    to,
    subject: "Your GiftCred verification code",
    text: `Your GiftCred verification code is ${code}. It expires in ${config.otpTtlMinutes()} minutes.`,
    html: `<p>Your GiftCred verification code is <strong>${code}</strong>.</p><p>It expires in ${config.otpTtlMinutes()} minutes.</p>`,
  });
}

export async function requestLoginOtp(
  client: PoolClient,
  email: string,
  meta: { ipAddress?: string; userAgent?: string }
): Promise<void> {
  const normalized = normalizeEmail(email);
  const rateKey = otpRateLimitKey(normalized);

  if (isRedisReady()) {
    const redis = getRedis();
    const attempts = await redis.incr(rateKey);
    if (attempts === 1) await redis.expire(rateKey, 300);
    if (attempts > 5) throw new AuthError("Too many OTP requests. Try again later.", 429);
  }

  const userResult = await client.query<{ id: number; account_id: number; status: string }>(
    `SELECT id, account_id, status FROM users WHERE email = $1`,
    [normalized]
  );
  const user = userResult.rows[0];
  if (!user || user.status !== "active") {
    throw new AuthError("No active account found for this email.", 404);
  }

  const code = generateOtpCode();
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + config.otpTtlMinutes());

  await client.query(
    `
    INSERT INTO email_otps (user_id, email, code_hash, purpose, expires_at, ip_address)
    VALUES ($1, $2, $3, 'login', $4, $5)
    `,
    [user.id, normalized, hashToken(code), expiresAt.toISOString(), meta.ipAddress ?? null]
  );

  await sendOtpEmail(normalized, code);

  await writeAuditLog(client, {
    actingUserId: user.id,
    accountId: user.account_id,
    action: AuditAction.OTP_SENT,
    newValue: { purpose: "login" },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}

export async function verifyLoginOtp(
  client: PoolClient,
  email: string,
  code: string,
  meta: { ipAddress?: string; userAgent?: string }
) {
  const normalized = normalizeEmail(email);
  const result = await client.query<{
    id: number;
    user_id: number | null;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `
    SELECT id, user_id, expires_at, used_at
    FROM email_otps
    WHERE email = $1 AND purpose = 'login' AND code_hash = $2 AND used_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [normalized, hashToken(code)]
  );

  const otp = result.rows[0];
  if (!otp || new Date(otp.expires_at) < new Date()) {
    throw new AuthError("Invalid or expired OTP.", 401);
  }

  await client.query(`UPDATE email_otps SET used_at = NOW() WHERE id = $1`, [otp.id]);

  const userResult = await client.query<{
    id: number;
    email: string;
    account_id: number;
    role_id: number;
    status: string;
  }>(`SELECT id, email, account_id, role_id, status FROM users WHERE email = $1`, [normalized]);

  const user = userResult.rows[0];
  if (!user || user.status !== "active") throw new AuthError("Account is not active.", 403);

  await writeAuditLog(client, {
    actingUserId: user.id,
    accountId: user.account_id,
    action: AuditAction.OTP_VERIFIED,
    newValue: { purpose: "login" },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return user;
}
