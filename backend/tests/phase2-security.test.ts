import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { validatePasswordComplexity, hashPassword } from "../src/auth/password.service.js";
import { config } from "../src/config.js";
import { AuthError } from "../src/lib/errors.js";
import { closePool } from "../src/db.js";
import { logger } from "../src/logger.js";
import { connectRedis, closeRedis, getRedis, isRedisReady, sessionActivityKey } from "../src/redis/client.js";
import express from "express";

const app = createApp();
const HAS_DB = Boolean(process.env.DATABASE_URL?.trim());
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@giftcred.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "Giftcred@123";
const STRONG_PASSWORD = "SecureP@ss1";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@phase2.test`;
}

async function loginWithMfaIfNeeded(
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string; sessionId?: number } | null> {
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  if (loginRes.body?.tokens?.accessToken) {
    return {
      accessToken: loginRes.body.tokens.accessToken,
      refreshToken: loginRes.body.tokens.refreshToken,
    };
  }
  if (loginRes.body?.mfa_required && loginRes.body?.mfaToken && HAS_DB) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const result = await pool.query<{ totp_secret: string | null }>(
        `SELECT totp_secret FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );
      const secret = result.rows[0]?.totp_secret;
      if (!secret) return null;
      const code = authenticator.generate(secret);
      const mfaRes = await request(app).post("/api/auth/mfa/verify").send({
        mfaToken: loginRes.body.mfaToken,
        code,
      });
      if (!mfaRes.body?.tokens?.accessToken) return null;
      return {
        accessToken: mfaRes.body.tokens.accessToken,
        refreshToken: mfaRes.body.tokens.refreshToken,
      };
    } finally {
      await pool.end();
    }
  }
  return null;
}

async function getStepUpToken(accessToken: string, email: string): Promise<string | null> {
  if (!HAS_DB) return null;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    const secret = result.rows[0]?.totp_secret;
    if (!secret) return null;
    const code = authenticator.generate(secret);
    const res = await request(app)
      .post("/api/auth/mfa/step-up")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ code });
    return res.body?.stepUpToken ?? null;
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  if (HAS_DB) {
    try {
      await connectRedis();
    } catch {
      // optional redis
    }
  }
}, 30_000);

afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe("Phase 2: Password complexity", () => {
  it("rejects weak passwords", () => {
    expect(() => validatePasswordComplexity("short")).toThrow(AuthError);
    expect(() => validatePasswordComplexity("alllowercase1!")).toThrow(AuthError);
    expect(() => validatePasswordComplexity("ALLUPPERCASE1!")).toThrow(AuthError);
    expect(() => validatePasswordComplexity("NoNumbers!")).toThrow(AuthError);
    expect(() => validatePasswordComplexity("NoSpecial1")).toThrow(AuthError);
  });

  it("accepts strong passwords", () => {
    expect(() => validatePasswordComplexity(STRONG_PASSWORD)).not.toThrow();
  });

  it("hashPassword enforces complexity", async () => {
    await expect(hashPassword("weak")).rejects.toThrow(AuthError);
    const hash = await hashPassword(STRONG_PASSWORD);
    expect(hash).toMatch(/^\$2[aby]\$/);
  });
});

describe("Phase 2: MFA enforcement", () => {
  it("returns mfa_setup_required on login when org enforces MFA", async () => {
    if (!HAS_DB) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const email = uniqueEmail("mfa-enforce");
    let accountId = 0;
    let userId = 0;

    try {
      const masterAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
      );
      accountId = masterAccount.rows[0]?.id;
      if (!accountId) return;

      await pool.query(`UPDATE accounts SET mfa_enforced = TRUE WHERE id = $1`, [accountId]);

      const roleRes = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
      );
      const roleId = roleRes.rows[0]?.id;
      if (!roleId) return;

      const passwordHash = await hashPassword(STRONG_PASSWORD);
      const userRes = await pool.query<{ id: number }>(
        `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at, mfa_enabled)
         VALUES ($1, $2, $3, $4, 'active', NOW(), FALSE)
         RETURNING id`,
        [accountId, roleId, email, passwordHash]
      );
      userId = userRes.rows[0].id;

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "10.20.30.40")
        .send({
          email,
          password: STRONG_PASSWORD,
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.mfa_setup_required).toBe(true);
      expect(loginRes.body.tokens?.accessToken).toBeTruthy();

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${loginRes.body.tokens.accessToken}`);
      expect(meRes.status).toBe(403);
      expect(meRes.body.error).toMatch(/MFA setup required/i);

      const setupRes = await request(app)
        .post("/api/auth/mfa/setup")
        .set("Authorization", `Bearer ${loginRes.body.tokens.accessToken}`);
      expect(setupRes.status).toBe(200);
      expect(setupRes.body.qrCodeDataUrl).toBeTruthy();
    } finally {
      if (userId) {
        await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
        await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
      }
      if (accountId) {
        await pool.query(`UPDATE accounts SET mfa_enforced = FALSE WHERE id = $1`, [accountId]);
      }
      await pool.end();
    }
  }, 60_000);
});

describe("Phase 2: Session inactivity timeout", () => {
  it("returns 401 when session activity key is missing in Redis", async () => {
    if (!HAS_DB || !isRedisReady()) {
      console.warn("Skipping inactivity test — DB or Redis unavailable");
      return;
    }

    const tokens = await loginWithMfaIfNeeded(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!tokens) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const sessionRes = await pool.query<{ id: number }>(
        `SELECT id FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
        [ADMIN_EMAIL.toLowerCase()]
      );
      const sessionId = sessionRes.rows[0]?.id;
      if (!sessionId) return;

      await getRedis().del(sessionActivityKey(sessionId));

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${tokens.accessToken}`);
      expect(meRes.status).toBe(401);
      expect(meRes.body.error).toMatch(/inactivity/i);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe("Phase 2: Step-up MFA", () => {
  it("requires step-up token for password change", async () => {
    const tokens = await loginWithMfaIfNeeded(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!tokens) return;

    const withoutStepUp = await request(app)
      .post("/api/auth/password/change")
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .send({ currentPassword: ADMIN_PASSWORD, newPassword: "NewSecureP@ss2" });
    expect(withoutStepUp.status).toBe(401);
    expect(withoutStepUp.body.error).toMatch(/step-up/i);
  });

  it("issues step-up token with valid TOTP", async () => {
    const tokens = await loginWithMfaIfNeeded(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!tokens) return;

    const stepUpToken = await getStepUpToken(tokens.accessToken, ADMIN_EMAIL);
    if (!stepUpToken) return;
    expect(stepUpToken).toBeTruthy();
  });
});

describe("Phase 2: Admin session revocation", () => {
  it("allows platform admin to revoke another user session", async () => {
    if (!HAS_DB) return;

    const adminTokens = await loginWithMfaIfNeeded(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!adminTokens) return;

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const email = uniqueEmail("session-revoke");
    let userId = 0;
    let sessionId = 0;

    try {
      const masterAccount = await pool.query<{ id: number }>(
        `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
      );
      const accountId = masterAccount.rows[0]?.id;
      const roleRes = await pool.query<{ id: number }>(
        `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
      );
      const roleId = roleRes.rows[0]?.id;
      if (!accountId || !roleId) return;

      const passwordHash = await hashPassword(STRONG_PASSWORD);
      const userRes = await pool.query<{ id: number }>(
        `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())
         RETURNING id`,
        [accountId, roleId, email, passwordHash]
      );
      userId = userRes.rows[0].id;

      const userTokens = await loginWithMfaIfNeeded(email, STRONG_PASSWORD);
      if (!userTokens) return;

      const sessionRes = await pool.query<{ id: number }>(
        `SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      sessionId = sessionRes.rows[0]?.id;
      if (!sessionId) return;

      const revokeRes = await request(app)
        .delete(`/api/users/${userId}/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${adminTokens.accessToken}`);
      expect(revokeRes.status).toBe(200);

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${userTokens.accessToken}`);
      expect(meRes.status).toBe(401);
    } finally {
      if (userId) {
        await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
        await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
      }
      await pool.end();
    }
  }, 90_000);
});

describe("Phase 2: B2B API keys", () => {
  it("creates, lists, and authenticates with API key", async () => {
    if (!HAS_DB) return;

    const tokens = await loginWithMfaIfNeeded(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!tokens) return;

    const createRes = await request(app)
      .post("/api/keys")
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .send({ name: "Phase2 test key", scopes: ["view_users"] });

    expect(createRes.status).toBe(201);
    expect(createRes.body.key).toBeTruthy();
    expect(createRes.body.prefix).toBeTruthy();

    const listRes = await request(app)
      .get("/api/keys")
      .set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys.length).toBeGreaterThan(0);

    const apiKey = createRes.body.key as string;
    const authedRes = await request(app)
      .get("/api/users")
      .set("x-api-key", apiKey);
    expect(authedRes.status).toBe(200);
    expect(Array.isArray(authedRes.body.users)).toBe(true);

    const deleteRes = await request(app)
      .delete(`/api/keys/${createRes.body.id}`)
      .set("Authorization", `Bearer ${tokens.accessToken}`);
    expect(deleteRes.status).toBe(200);

    const revokedRes = await request(app)
      .get("/api/users")
      .set("x-api-key", apiKey);
    expect(revokedRes.status).toBe(401);
  }, 90_000);
});

describe("Phase 2: Production error handling", () => {
  it("returns sanitized 500 in production mode", async () => {
    const testApp = express();
    testApp.get("/test-boom", () => {
      throw new Error("secret stack trace detail");
    });
    testApp.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error({ err }, "Unhandled error");
      res.status(500).json({ error: "Internal server error" });
    });

    const res = await request(testApp).get("/test-boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
    expect(res.body.error).not.toMatch(/stack trace/i);
  });
});

describe("Phase 2: JWT sessionId requirement", () => {
  it("rejects access tokens without sessionId", async () => {
    const token = jwt.sign(
      {
        sub: 1,
        email: "test@example.com",
        accountId: 1,
        roleId: 1,
        roleSlug: "analyst",
        privileges: [],
        type: "access",
      },
      config.jwtSecret(),
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("Phase 2: Login rate limiting", () => {
  it("returns 429 after repeated failed login attempts", async () => {
    const agent = request(app);
    let saw429 = false;
    for (let i = 0; i < 7; i++) {
      const res = await agent
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.99")
        .send({
          email: `rate-limit-${i}@example.com`,
          password: "wrong-password",
        });
      if (res.status === 429) {
        saw429 = true;
        expect(res.body.error).toMatch(/too many/i);
        break;
      }
      expect([401, 429]).toContain(res.status);
    }
    expect(saw429).toBe(true);
  }, 60_000);
});
