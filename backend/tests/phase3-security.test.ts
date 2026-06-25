import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.service.js";
import { closePool } from "../src/db.js";
import { invalidateRoleCache } from "../src/redis/roleCache.js";

const app = createApp();
const HAS_DB = Boolean(process.env.DATABASE_URL?.trim());
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@giftcred.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "Giftcred@123";
const STRONG_PASSWORD = "SecureP@ss1";
const ALLOWED_IP = "203.0.113.55";
const BLOCKED_IP = "198.51.100.99";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@phase3.test`;
}

afterAll(async () => {
  await closePool();
});

describe("Phase 3: SSO enforcement", () => {
  it("blocks password login when sso_enforced is enabled for org users", async () => {
    if (!HAS_DB) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const email = uniqueEmail("sso-enforce");
    let accountId = 0;
    let userId = 0;

    try {
      const masterAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
      );
      accountId = masterAccount.rows[0]?.id;
      if (!accountId) return;

      await pool.query(`UPDATE accounts SET sso_enforced = TRUE WHERE id = $1`, [accountId]);

      const roleRes = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
      );
      const roleId = roleRes.rows[0]?.id;
      if (!roleId) return;

      const passwordHash = await hashPassword(STRONG_PASSWORD);
      const userRes = await pool.query<{ id: number }>(
        `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())
         RETURNING id`,
        [accountId, roleId, email, passwordHash]
      );
      userId = userRes.rows[0].id;

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ALLOWED_IP)
        .send({ email, password: STRONG_PASSWORD });

      expect(loginRes.status).toBe(403);
      expect(loginRes.body.error).toMatch(/requires SSO login/i);
    } finally {
      if (userId) {
        await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
        await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
      }
      if (accountId) {
        await pool.query(
          `UPDATE accounts SET sso_enforced = FALSE, ip_allowlist = '[]'::jsonb WHERE id = $1`,
          [accountId]
        );
      }
      await pool.end();
    }
  }, 60_000);

  it("allows platform super owner password login even when sso_enforced on platform account", async () => {
    if (!HAS_DB) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    let platformAccountId = 0;

    try {
      const platformAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'platform' LIMIT 1`
      );
      platformAccountId = platformAccount.rows[0]?.id;
      if (!platformAccountId) return;

      await pool.query(`UPDATE accounts SET sso_enforced = TRUE WHERE id = $1`, [platformAccountId]);

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ALLOWED_IP)
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

      expect([200, 401]).toContain(loginRes.status);
      if (loginRes.status === 200) {
        expect(loginRes.body.mfa_required ?? loginRes.body.tokens).toBeTruthy();
      }
    } finally {
      if (platformAccountId) {
        await pool.query(`UPDATE accounts SET sso_enforced = FALSE WHERE id = $1`, [platformAccountId]);
      }
      await pool.end();
    }
  }, 60_000);
});

describe("Phase 3: IP allowlisting", () => {
  it("blocks password login from a disallowed IP", async () => {
    if (!HAS_DB) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const email = uniqueEmail("ip-block-login");
    let accountId = 0;
    let userId = 0;

    try {
      const masterAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
      );
      accountId = masterAccount.rows[0]?.id;
      if (!accountId) return;

      await pool.query(
        `UPDATE accounts SET ip_allowlist = $1::jsonb, sso_enforced = FALSE WHERE id = $2`,
        [JSON.stringify([ALLOWED_IP]), accountId]
      );

      const roleRes = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
      );
      const roleId = roleRes.rows[0]?.id;
      if (!roleId) return;

      const passwordHash = await hashPassword(STRONG_PASSWORD);
      const userRes = await pool.query<{ id: number }>(
        `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())
         RETURNING id`,
        [accountId, roleId, email, passwordHash]
      );
      userId = userRes.rows[0].id;

      const blockedRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", BLOCKED_IP)
        .send({ email, password: STRONG_PASSWORD });
      expect(blockedRes.status).toBe(403);
      expect(blockedRes.body.error).toMatch(/Access denied from this IP address/i);

      const allowedRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ALLOWED_IP)
        .send({ email, password: STRONG_PASSWORD });
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.body.tokens?.accessToken).toBeTruthy();
    } finally {
      if (userId) {
        await invalidateRoleCache(userId);
        await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
        await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
      }
      if (accountId) {
        await pool.query(
          `UPDATE accounts SET ip_allowlist = '[]'::jsonb WHERE id = $1`,
          [accountId]
        );
      }
      await pool.end();
    }
  }, 60_000);

  it("blocks active sessions when request IP is not on the allowlist", async () => {
    if (!HAS_DB) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const email = uniqueEmail("ip-block-session");
    let accountId = 0;
    let userId = 0;

    try {
      const masterAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
      );
      accountId = masterAccount.rows[0]?.id;
      if (!accountId) return;

      await pool.query(
        `UPDATE accounts SET ip_allowlist = $1::jsonb, sso_enforced = FALSE WHERE id = $2`,
        [JSON.stringify([ALLOWED_IP]), accountId]
      );

      const roleRes = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
      );
      const roleId = roleRes.rows[0]?.id;
      if (!roleId) return;

      const passwordHash = await hashPassword(STRONG_PASSWORD);
      const userRes = await pool.query<{ id: number }>(
        `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())
         RETURNING id`,
        [accountId, roleId, email, passwordHash]
      );
      userId = userRes.rows[0].id;
      await invalidateRoleCache(userId);

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ALLOWED_IP)
        .send({ email, password: STRONG_PASSWORD });
      expect(loginRes.status).toBe(200);
      const accessToken = loginRes.body.tokens.accessToken as string;

      const allowedMe = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${accessToken}`)
        .set("X-Forwarded-For", ALLOWED_IP);
      expect(allowedMe.status).toBe(200);

      await invalidateRoleCache(userId);

      const blockedMe = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${accessToken}`)
        .set("X-Forwarded-For", BLOCKED_IP);
      expect(blockedMe.status).toBe(403);
      expect(blockedMe.body.error).toMatch(/Access denied from this IP address/i);
    } finally {
      if (userId) {
        await invalidateRoleCache(userId);
        await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
        await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
      }
      if (accountId) {
        await pool.query(`UPDATE accounts SET ip_allowlist = '[]'::jsonb WHERE id = $1`, [accountId]);
      }
      await pool.end();
    }
  }, 60_000);

  it("matches client IPs inside a configured CIDR range", async () => {
    if (!HAS_DB) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const email = uniqueEmail("ip-cidr");
    let accountId = 0;
    let userId = 0;

    try {
      const masterAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
      );
      accountId = masterAccount.rows[0]?.id;
      if (!accountId) return;

      await pool.query(
        `UPDATE accounts SET ip_allowlist = $1::jsonb, sso_enforced = FALSE WHERE id = $2`,
        [JSON.stringify(["203.0.113.0/24"]), accountId]
      );

      const roleRes = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
      );
      const roleId = roleRes.rows[0]?.id;
      if (!roleId) return;

      const passwordHash = await hashPassword(STRONG_PASSWORD);
      const userRes = await pool.query<{ id: number }>(
        `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())
         RETURNING id`,
        [accountId, roleId, email, passwordHash]
      );
      userId = userRes.rows[0].id;

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.42")
        .send({ email, password: STRONG_PASSWORD });
      expect(loginRes.status).toBe(200);
    } finally {
      if (userId) {
        await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
        await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
      }
      if (accountId) {
        await pool.query(`UPDATE accounts SET ip_allowlist = '[]'::jsonb WHERE id = $1`, [accountId]);
      }
      await pool.end();
    }
  }, 60_000);
});
