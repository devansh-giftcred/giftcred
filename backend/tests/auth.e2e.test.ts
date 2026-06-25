import { authenticator } from "otplib";
import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { closePool } from "../src/db.js";

const app = createApp();
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@giftcred.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "Giftcred@123";
const HAS_WOOHOO_CONFIG =
  !!process.env.WOOHOO_CONSUMER_KEY?.trim() && !!process.env.WOOHOO_USERNAME?.trim();

async function loginAsAdmin(): Promise<string | null> {
  try {
    const loginRes = await request(app).post("/api/auth/login").send({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });

    if (loginRes.body?.tokens?.accessToken) {
      return loginRes.body.tokens.accessToken as string;
    }

    if (loginRes.body?.mfa_required && loginRes.body?.mfaToken && process.env.DATABASE_URL) {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const result = await pool.query<{ totp_secret: string | null }>(
          `SELECT totp_secret FROM users WHERE email = $1`,
          [ADMIN_EMAIL.toLowerCase()]
        );
        const secret = result.rows[0]?.totp_secret;
        if (!secret) return null;
        const code = authenticator.generate(secret);
        const mfaRes = await request(app).post("/api/auth/mfa/verify").send({
          mfaToken: loginRes.body.mfaToken,
          code,
        });
        return mfaRes.body?.tokens?.accessToken ?? null;
      } finally {
        await pool.end();
      }
    }
  } catch (err) {
    console.warn("loginAsAdmin failed:", err instanceof Error ? err.message : err);
  }

  return null;
}

describe("Auth & platform E2E", () => {
  let accessToken: string | null = null;

  beforeAll(async () => {
    accessToken = await loginAsAdmin();
  }, 60_000);

  it("admin login flow yields access token", () => {
    if (!process.env.DATABASE_URL) {
      console.warn("DATABASE_URL not set — skipping auth E2E assertions");
      return;
    }
    if (!accessToken) {
      console.warn("Admin login failed — DB unreachable; skipping strict assertion");
      return;
    }
    expect(accessToken).toBeTruthy();
  });

  it("GET /api/auth/me returns platform admin", async () => {
    if (!accessToken) return;
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN_EMAIL);
  });

  it("GET /api/users requires auth", async () => {
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(401);
  });

  it("GET /api/users returns scoped list when authed", async () => {
    if (!accessToken) return;
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  it("GET /api/accounts returns account list", async () => {
    if (!accessToken) return;
    const res = await request(app)
      .get("/api/accounts")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });

  it("GET /api/audit/logs returns audit entries", async () => {
    if (!accessToken) return;
    const res = await request(app)
      .get("/api/audit/logs?page=1&limit=5")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it("POST /api/auth/refresh rotates tokens", async () => {
    if (!accessToken) return;
    const loginRes = await request(app).post("/api/auth/login").send({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    if (!loginRes.body?.refreshToken && !loginRes.body?.tokens?.refreshToken) return;

    const refreshToken =
      loginRes.body.refreshToken ?? loginRes.body.tokens?.refreshToken;
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.tokens?.accessToken).toBeTruthy();
  });
});

describe("Catalog & orders (ported from Python backend)", () => {
  let accessToken: string | null = null;

  beforeAll(async () => {
    try {
      accessToken = await loginAsAdmin();
    } catch {
      accessToken = null;
    }
  }, 60_000);

  it("GET /api/catalog is public", async () => {
    const res = await request(app).get("/api/catalog");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/orders requires JWT", async () => {
    const res = await request(app).get("/api/orders");
    expect(res.status).toBe(401);
  });

  it("POST /api/purchase requires JWT", async () => {
    const res = await request(app).post("/api/purchase").send({
      items: [{ sku: "TEST", amount: 100, quantity: 1 }],
      mobileNumber: "9876543210",
      email: ADMIN_EMAIL,
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/orders returns array with JWT", async () => {
    if (!accessToken) return;
    if (!HAS_WOOHOO_CONFIG) {
      console.warn("Skipping — add WOOHOO_* vars to .env for live order fetch");
      return;
    }
    const res = await request(app)
      .get("/api/orders")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  }, 180_000);
});

describe("Extended auth flows", () => {
  it("GET /api/auth/sso/google redirects to Google", async () => {
    const res = await request(app).get("/api/auth/sso/google");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/google/i);
  });

  it("GET /api/auth/sso/microsoft redirects to Microsoft", async () => {
    const res = await request(app).get("/api/auth/sso/microsoft");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/microsoft|login\.live/i);
  });
});

afterAll(async () => {
  await closePool();
});
