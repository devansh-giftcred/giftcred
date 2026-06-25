import type { PoolClient } from "pg";
import { config } from "../config.js";
import { AuthError } from "../lib/errors.js";
import {
  getRedis,
  isRedisReady,
  SESSION_ACTIVITY_TTL_SECONDS,
  sessionActivityKey,
} from "../redis/client.js";
import { hashToken } from "./crypto.utils.js";

export interface SessionMeta {
  ipAddress?: string;
  userAgent?: string;
  deviceInfo?: Record<string, unknown>;
}

export interface ActiveSessionRow {
  id: number;
  ip_address: string | null;
  user_agent: string | null;
  device_info: Record<string, unknown>;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
}

export async function createSession(
  client: PoolClient,
  userId: number,
  refreshToken: string,
  meta: SessionMeta
): Promise<number> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.jwtRefreshTtlDays());

  const result = await client.query<{ id: number }>(
    `
    INSERT INTO user_sessions (
      user_id, refresh_token_hash, device_info, ip_address, user_agent, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
    `,
    [
      userId,
      hashToken(refreshToken),
      JSON.stringify(meta.deviceInfo ?? {}),
      meta.ipAddress ?? null,
      meta.userAgent ?? null,
      expiresAt.toISOString(),
    ]
  );
  const sessionId = result.rows[0].id;
  await trackSessionActivity(sessionId);
  return sessionId;
}

export async function trackSessionActivity(sessionId: number): Promise<void> {
  if (!isRedisReady()) return;
  try {
    await getRedis().set(
      sessionActivityKey(sessionId),
      "1",
      "EX",
      SESSION_ACTIVITY_TTL_SECONDS
    );
  } catch {
    // non-fatal
  }
}

export async function refreshSessionActivity(sessionId: number): Promise<boolean> {
  if (!isRedisReady()) return true;
  try {
    const key = sessionActivityKey(sessionId);
    const exists = await getRedis().exists(key);
    if (!exists) return false;
    await getRedis().expire(key, SESSION_ACTIVITY_TTL_SECONDS);
    return true;
  } catch {
    return true;
  }
}

export async function clearSessionActivity(sessionId: number): Promise<void> {
  if (!isRedisReady()) return;
  try {
    await getRedis().del(sessionActivityKey(sessionId));
  } catch {
    // non-fatal
  }
}

export async function findActiveSessionByToken(client: PoolClient, refreshToken: string) {
  const result = await client.query<{
    id: number;
    user_id: number;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `
    SELECT id, user_id, expires_at, revoked_at
    FROM user_sessions
    WHERE refresh_token_hash = $1
    `,
    [hashToken(refreshToken)]
  );
  const row = result.rows[0];
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

export async function findActiveSessions(
  client: PoolClient,
  userId: number
): Promise<ActiveSessionRow[]> {
  const result = await client.query<ActiveSessionRow>(
    `
    SELECT id, ip_address, user_agent, device_info, created_at, last_used_at, expires_at
    FROM user_sessions
    WHERE user_id = $1
      AND revoked_at IS NULL
      AND expires_at > NOW()
    ORDER BY last_used_at DESC
    `,
    [userId]
  );
  return result.rows;
}

export async function rotateSession(
  client: PoolClient,
  oldSessionId: number,
  userId: number,
  newRefreshToken: string,
  meta: SessionMeta
): Promise<number> {
  const newSessionId = await createSession(client, userId, newRefreshToken, meta);
  await client.query(
    `
    UPDATE user_sessions
    SET revoked_at = NOW(), replaced_by_id = $2, last_used_at = NOW()
    WHERE id = $1
    `,
    [oldSessionId, newSessionId]
  );
  return newSessionId;
}

export async function isSessionActive(
  client: PoolClient,
  sessionId: number,
  userId: number
): Promise<boolean> {
  const result = await client.query(
    `
    SELECT id
    FROM user_sessions
    WHERE id = $1
      AND user_id = $2
      AND revoked_at IS NULL
      AND expires_at > NOW()
  `,
    [sessionId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeSession(client: PoolClient, sessionId: number): Promise<boolean> {
  const result = await client.query(
    `UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [sessionId]
  );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) {
    await clearSessionActivity(sessionId);
  }
  return revoked;
}

export async function revokeSessionForUser(
  client: PoolClient,
  userId: number,
  sessionId: number
): Promise<void> {
  const result = await client.query(
    `
    UPDATE user_sessions
    SET revoked_at = NOW()
    WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
    RETURNING id
    `,
    [sessionId, userId]
  );
  if (!result.rows.length) {
    throw new AuthError("Session not found.", 404);
  }
}

export async function revokeAllUserSessions(client: PoolClient, userId: number): Promise<void> {
  await client.query(
    `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}
