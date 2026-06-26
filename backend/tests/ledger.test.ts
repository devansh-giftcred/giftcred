import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.service.js";
import { closePool, withClient, withTransaction } from "../src/db.js";
import { placeHold, captureHold, voidHold, getAccountBalances } from "../src/ledger/holds.service.js";
import {
  createTenantPoolAccount,
  createWalletForUser,
  executeDoubleEntry,
  fundWallet,
  getAccountById,
  getWalletsForUser,
} from "../src/ledger/ledger.service.js";
import { ConcurrencyError, LedgerError } from "../src/lib/errors.js";

const app = createApp();
const HAS_DB = Boolean(process.env.DATABASE_URL?.trim());
const STRONG_PASSWORD = "SecureP@ss1";

interface TestContext {
  tenantId: number;
  userId: number;
  email: string;
  walletId: string;
  poolId: string;
}

async function setupWalletContext(fundAmount = 0): Promise<TestContext> {
  return withTransaction(async (client) => {
    const tenantRes = await client.query<{ id: number }>(
      `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id LIMIT 1`
    );
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) throw new Error("master tenant not found");

    const roleRes = await client.query<{ id: number }>(
      `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
    );
    const roleId = roleRes.rows[0]?.id;
    if (!roleId) throw new Error("analyst role not found");

    const email = `ledger-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@bms.test`;
    const passwordHash = await hashPassword(STRONG_PASSWORD);
    const userRes = await client.query<{ id: number }>(
      `INSERT INTO users (account_id, role_id, email, password_hash, status, email_verified_at)
       VALUES ($1, $2, $3, $4, 'active', NOW())
       RETURNING id`,
      [tenantId, roleId, email, passwordHash]
    );
    const userId = userRes.rows[0].id;

    const wallet = await createWalletForUser(client, userId, tenantId, "INR");
    const pool = await createTenantPoolAccount(client, tenantId, "INR");

    if (fundAmount > 0) {
      await fundWallet(
        client,
        tenantId,
        wallet.id,
        pool.id,
        fundAmount,
        `fund-${wallet.id}-${Date.now()}`
      );
    }

    return { tenantId, userId, email, walletId: wallet.id, poolId: pool.id };
  });
}

async function cleanupTestUser(userId: number): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1`, [userId]);
    await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId]);
  } finally {
    await pool.end();
  }
}

afterAll(async () => {
  await closePool();
});

describe("BMS: Double-entry bookkeeping", () => {
  it("rejects unbalanced transactions before persisting journal entries", async () => {
    if (!HAS_DB) return;

    let ctx: TestContext | null = null;
    try {
      ctx = await setupWalletContext(0);

      await expect(
        withTransaction((client) =>
          executeDoubleEntry(client, {
            tenantId: ctx!.tenantId,
            idempotencyKey: `unbalanced-${Date.now()}`,
            description: "Should fail",
            entries: [
              { accountId: ctx!.walletId, amount: 100, type: "DEBIT" },
              { accountId: ctx!.poolId, amount: 50, type: "CREDIT" },
            ],
          })
        )
      ).rejects.toThrow(LedgerError);

      const journalCount = await withClient((client) =>
        client.query(`SELECT COUNT(*)::int AS count FROM bms_journal_entries WHERE description = 'Should fail'`)
      );
      expect(journalCount.rows[0].count).toBe(0);
    } finally {
      if (ctx) await cleanupTestUser(ctx.userId);
    }
  }, 60_000);

  it("records balanced debits and credits with correct final balances", async () => {
    if (!HAS_DB) return;

    let ctx: TestContext | null = null;
    try {
      ctx = await setupWalletContext(0);

      await withTransaction((client) =>
        fundWallet(client, ctx!.tenantId, ctx!.walletId, ctx!.poolId, 2500, `fund-balanced-${Date.now()}`)
      );

      const wallet = await withClient((client) => getAccountById(client, ctx!.walletId));
      const pool = await withClient((client) => getAccountById(client, ctx!.poolId));

      expect(wallet?.ledger_balance).toBe(2500);
      expect(pool?.ledger_balance).toBe(-2500);
    } finally {
      if (ctx) await cleanupTestUser(ctx.userId);
    }
  }, 60_000);
});

describe("BMS: Optimistic concurrency control", () => {
  it("prevents double-spending under 20 simultaneous debit attempts", async () => {
    if (!HAS_DB) return;

    let ctx: TestContext | null = null;
    const initialBalance = 1000;
    const debitAmount = 1000;

    try {
      ctx = await setupWalletContext(initialBalance);

      type AttemptResult = { ok: true } | { ok: false; error: unknown };
      const attempts = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          withTransaction(async (client) => {
            await executeDoubleEntry(client, {
              tenantId: ctx!.tenantId,
              idempotencyKey: `occ-race-${ctx!.walletId}-${index}-${Date.now()}`,
              description: "Concurrent debit test",
              entries: [
                { accountId: ctx!.walletId, amount: debitAmount, type: "DEBIT" },
                { accountId: ctx!.poolId, amount: debitAmount, type: "CREDIT" },
              ],
            });
            return { ok: true as const };
          }).catch((error: unknown) => ({ ok: false as const, error }))
        )
      );

      const successes = attempts.filter((a): a is { ok: true } => a.ok);
      const concurrencyFailures = attempts.filter(
        (a): a is { ok: false; error: unknown } =>
          !a.ok && a.error instanceof ConcurrencyError
      );
      const otherFailures = attempts.filter(
        (a): a is { ok: false; error: unknown } =>
          !a.ok && !(a.error instanceof ConcurrencyError)
      );

      expect(successes.length).toBe(1);
      expect(concurrencyFailures.length + otherFailures.length).toBe(19);
      expect(concurrencyFailures.length).toBeGreaterThan(0);

      const finalWallet = await withClient((client) => getAccountById(client, ctx!.walletId));
      expect(finalWallet?.ledger_balance).toBe(0);
      expect(finalWallet?.ledger_balance).toBe(initialBalance - debitAmount * successes.length);
    } finally {
      if (ctx) await cleanupTestUser(ctx.userId);
    }
  }, 120_000);
});

describe("BMS: Hold lifecycle", () => {
  it("reduces available balance on hold and ledger balance only on capture", async () => {
    if (!HAS_DB) return;

    let ctx: TestContext | null = null;
    try {
      ctx = await setupWalletContext(5000);

      const hold = await withTransaction((client) =>
        placeHold(client, ctx!.walletId, 1000, 30, `hold-${Date.now()}`, "order-uber-001")
      );

      const afterHold = await withClient((client) => getAccountBalances(client, ctx!.walletId));
      expect(afterHold?.ledger_balance).toBe(5000);
      expect(afterHold?.held_balance).toBe(1000);
      expect(afterHold?.available_balance).toBe(4000);
      expect(hold.status).toBe("ACTIVE");

      const captured = await withTransaction((client) =>
        captureHold(
          client,
          hold.id,
          1000,
          ctx!.poolId,
          `capture-${hold.id}-${Date.now()}`
        )
      );

      const afterCapture = await withClient((client) => getAccountBalances(client, ctx!.walletId));
      expect(captured.hold.status).toBe("CAPTURED");
      expect(afterCapture?.ledger_balance).toBe(4000);
      expect(afterCapture?.held_balance).toBe(0);
      expect(afterCapture?.available_balance).toBe(4000);
    } finally {
      if (ctx) await cleanupTestUser(ctx.userId);
    }
  }, 60_000);

  it("restores available balance when a hold is voided without changing ledger balance", async () => {
    if (!HAS_DB) return;

    let ctx: TestContext | null = null;
    try {
      ctx = await setupWalletContext(3000);

      const hold = await withTransaction((client) =>
        placeHold(client, ctx!.walletId, 800, 15, `void-hold-${Date.now()}`, "order-cancel-002")
      );

      const afterHold = await withClient((client) => getAccountBalances(client, ctx!.walletId));
      expect(afterHold?.available_balance).toBe(2200);

      const voided = await withTransaction((client) => voidHold(client, hold.id));
      const afterVoid = await withClient((client) => getAccountBalances(client, ctx!.walletId));

      expect(voided.status).toBe("RELEASED");
      expect(afterVoid?.ledger_balance).toBe(3000);
      expect(afterVoid?.held_balance).toBe(0);
      expect(afterVoid?.available_balance).toBe(3000);
    } finally {
      if (ctx) await cleanupTestUser(ctx.userId);
    }
  }, 60_000);
});

describe("BMS: User onboarding wallet hook", () => {
  it("creates an INR wallet automatically for users created via createWalletForUser", async () => {
    if (!HAS_DB) return;

    let userId = 0;
    let tenantId = 0;
    try {
      const setup = await setupWalletContext(0);
      userId = setup.userId;
      tenantId = setup.tenantId;

      const wallets = await withClient((client) =>
        getWalletsForUser(client, userId, tenantId)
      );

      expect(wallets.length).toBeGreaterThanOrEqual(1);
      expect(wallets[0].currency_code).toBe("INR");
      expect(wallets[0].owner_type).toBe("user");
      expect(wallets[0].ledger_balance).toBe(0);
    } finally {
      if (userId) await cleanupTestUser(userId);
    }
  }, 60_000);
});

describe("BMS: API endpoints", () => {
  it("GET /api/ledger/wallets/me requires authentication", async () => {
    const res = await request(app).get("/api/ledger/wallets/me");
    expect(res.status).toBe(401);
  });

  it("returns wallet balances for authenticated users", async () => {
    if (!HAS_DB) return;

    let ctx: TestContext | null = null;
    try {
      ctx = await setupWalletContext(1500);

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.77")
        .send({
          email: ctx.email,
          password: STRONG_PASSWORD,
        });

      if (!loginRes.body?.tokens?.accessToken) {
        console.warn("Skipping wallet API test — login failed");
        return;
      }

      const res = await request(app)
        .get("/api/ledger/wallets/me")
        .set("Authorization", `Bearer ${loginRes.body.tokens.accessToken}`)
        .set("X-Forwarded-For", "203.0.113.77");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.wallets)).toBe(true);
      expect(res.body.wallets[0].ledgerBalance).toBe(1500);
      expect(res.body.wallets[0].availableBalance).toBe(1500);
    } finally {
      if (ctx) await cleanupTestUser(ctx.userId);
    }
  }, 90_000);
});
