import { config } from "../config.js";
import { query } from "../db.js";
import { getRedis, isRedisReady, roleCacheKey } from "./client.js";

export interface CachedRoleContext {
  userId: number;
  accountId: number;
  accountType: "platform" | "master" | "child";
  roleId: number;
  roleSlug: string;
  privileges: string[];
  isPlatformAdmin: boolean;
}

export async function getRoleFromCache(userId: number): Promise<CachedRoleContext | null> {
  if (!isRedisReady()) return null;
  try {
    const raw = await getRedis().get(roleCacheKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedRoleContext;
  } catch {
    return null;
  }
}

export async function setRoleCache(ctx: CachedRoleContext): Promise<void> {
  if (!isRedisReady()) return;
  try {
    await getRedis().set(
      roleCacheKey(ctx.userId),
      JSON.stringify(ctx),
      "EX",
      config.roleCacheTtlSeconds()
    );
  } catch (err) {
    console.warn("[redis] failed to cache role:", err instanceof Error ? err.message : err);
  }
}

export async function invalidateRoleCache(userId: number): Promise<void> {
  if (!isRedisReady()) return;
  try {
    await getRedis().del(roleCacheKey(userId));
  } catch {
    // non-fatal
  }
}

export async function loadRoleFromDb(userId: number): Promise<CachedRoleContext | null> {
  const result = await query<{
    user_id: number;
    account_id: number;
    account_type: "platform" | "master" | "child";
    role_id: number;
    role_slug: string;
    privilege_code: string | null;
  }>(
    `
    SELECT
      u.id AS user_id,
      u.account_id,
      a.account_type,
      r.id AS role_id,
      r.slug AS role_slug,
      p.code AS privilege_code
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN role_privileges rp ON rp.role_id = r.id
    LEFT JOIN privileges p ON p.id = rp.privilege_id
    WHERE u.id = $1 AND u.status = 'active'
    `,
    [userId]
  );

  if (!result.rows.length) return null;

  const first = result.rows[0];
  const privileges = [
    ...new Set(
      result.rows
        .map((row) => row.privilege_code)
        .filter((code): code is string => Boolean(code))
    ),
  ];

  const ctx: CachedRoleContext = {
    userId: first.user_id,
    accountId: first.account_id,
    accountType: first.account_type,
    roleId: first.role_id,
    roleSlug: first.role_slug,
    privileges,
    isPlatformAdmin: privileges.includes("platform_admin"),
  };

  await setRoleCache(ctx);
  return ctx;
}

export async function resolveUserRole(userId: number): Promise<CachedRoleContext | null> {
  const cached = await getRoleFromCache(userId);
  if (cached) return cached;
  return loadRoleFromDb(userId);
}
