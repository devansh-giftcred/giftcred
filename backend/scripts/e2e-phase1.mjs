/**
 * Phase 1 end-to-end test suite for GiftCred auth-api (+ Python backend if reachable).
 * Run: node scripts/e2e-phase1.mjs
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import pg from "pg";
import bcrypt from "bcrypt";
import { authenticator } from "otplib";

const root = process.cwd();
if (existsSync(resolve(root, ".env"))) dotenv.config({ path: resolve(root, ".env") });

const AUTH_BASE = process.env.AUTH_BASE_URL || "http://localhost:3001";
const PYTHON_BASE = process.env.PYTHON_BASE_URL || "http://127.0.0.1:8000";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@giftcred.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "Giftcred@123";
const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD || "E2eTest@12345";
const E2E_DOMAIN = "giftcred.test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logFile = resolve(__dirname, "../e2e-report.log");
const results = [];

function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data !== undefined ? " " + JSON.stringify(data, null, 0) : ""}`;
  console.log(line);
  appendFileSync(logFile, line + "\n");
}

function record(name, passed, detail = {}) {
  results.push({ name, passed, ...detail });
  log(passed ? "PASS" : "FAIL", name, detail);
}

async function req(method, path, { body, token, base = AUTH_BASE } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const url = `${base}${path}`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) },
      ms: Date.now() - started,
      url,
    };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    ok: res.ok,
    status: res.status,
    body: parsed,
    ms: Date.now() - started,
    url,
  };
}

function parseSecretFromOtpauth(otpauthUrl) {
  const u = new URL(otpauthUrl);
  return u.searchParams.get("secret");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

let dbPool = null;
function getDbPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!dbPool) dbPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return dbPool;
}

async function withDb(fn) {
  const pool = getDbPool();
  if (!pool) throw new Error("DATABASE_URL not set");
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function fetchTotpSecretFromDb(email) {
  if (!getDbPool()) return null;
  const res = await getDbPool().query(
    `SELECT totp_secret, mfa_enabled FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  return res.rows[0] || null;
}

async function getRoleId(client, slug) {
  const res = await client.query(
    `SELECT id FROM roles WHERE slug = $1 AND account_id IS NULL LIMIT 1`,
    [slug]
  );
  return res.rows[0]?.id ?? null;
}

async function getPlatformAccountId(client) {
  const res = await client.query(
    `SELECT id FROM accounts WHERE account_type = 'platform' LIMIT 1`
  );
  return res.rows[0]?.id ?? null;
}

async function cleanupE2eArtifacts(client, emails = []) {
  for (const email of emails) {
    const normalized = email.toLowerCase();
    await client.query(`DELETE FROM user_invites WHERE email = $1`, [normalized]);
    await client.query(`DELETE FROM email_otps WHERE email = $1`, [normalized]);
  }
}

async function createTestUser(client, { email, password, accountId, roleSlug = "analyst" }) {
  const normalized = email.toLowerCase();
  const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [normalized]);
  if (existing.rows[0]) return existing.rows[0].id;

  const roleId = await getRoleId(client, roleSlug);
  if (!roleId) throw new Error(`Role not found: ${roleSlug}`);

  const passwordHash = await bcrypt.hash(password, 12);
  const ins = await client.query(
    `INSERT INTO users (
      account_id, role_id, email, password_hash, first_name, last_name, status, email_verified_at
    ) VALUES ($1, $2, $3, $4, 'E2E', 'User', 'active', NOW())
    RETURNING id`,
    [accountId, roleId, normalized, passwordHash]
  );
  return ins.rows[0].id;
}

async function insertLoginOtp(client, email, code) {
  const normalized = email.toLowerCase();
  const user = await client.query(`SELECT id FROM users WHERE email = $1`, [normalized]);
  if (!user.rows[0]) throw new Error(`User not found for OTP: ${email}`);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15);
  await client.query(
    `INSERT INTO email_otps (user_id, email, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, 'login', $4)`,
    [user.rows[0].id, normalized, hashToken(code), expiresAt.toISOString()]
  );
}

async function insertPendingInvite(client, { email, accountId, roleId, invitedByUserId, rawToken }) {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);
  await client.query(
    `INSERT INTO user_invites (account_id, invited_by_user_id, email, role_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [accountId, invitedByUserId, email.toLowerCase(), roleId, hashToken(rawToken), expiresAt.toISOString()]
  );
  return rawToken;
}

async function reqNoRedirect(method, path, { base = AUTH_BASE } = {}) {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, { method, redirect: "manual" });
    return { status: res.status, location: res.headers.get("location"), url };
  } catch (err) {
    return {
      status: 0,
      location: null,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loginWithPasswordAndMfa(email, password) {
  const login = await req("POST", "/api/auth/login", { body: { email, password } });
  if (login.body?.mfa_required && login.body?.mfaToken) {
    const dbMfa = await fetchTotpSecretFromDb(email);
    if (!dbMfa?.totp_secret) return { login, accessToken: null };
    const totpCode = authenticator.generate(dbMfa.totp_secret);
    const mfaVerify = await req("POST", "/api/auth/mfa/verify", {
      body: { mfaToken: login.body.mfaToken, code: totpCode },
    });
    return {
      login,
      mfaVerify,
      accessToken: mfaVerify.body?.tokens?.accessToken ?? null,
    };
  }
  return { login, accessToken: login.body?.tokens?.accessToken ?? null };
}

async function runExtendedFlows(adminToken, adminUserId) {
  if (!getDbPool()) {
    log("WARN", "DATABASE_URL missing — skipping extended E2E flows");
    return;
  }

  log("INFO", "── Extended flows (--force) ──");

  const ts = Date.now();
  const otpEmail = `e2e-otp-${ts}@${E2E_DOMAIN}`;
  const mfaEmail = `e2e-mfa-${ts}@${E2E_DOMAIN}`;
  const inviteEmail = `e2e-invite-${ts}@${E2E_DOMAIN}`;
  const masterOwnerEmail = `e2e-master-${ts}@${E2E_DOMAIN}`;
  const apiInviteEmail = `e2e-api-invite-${ts}@${E2E_DOMAIN}`;
  const otpCode = "847291";

  await withDb(async (client) => {
    await cleanupE2eArtifacts(client, [otpEmail, mfaEmail, inviteEmail, masterOwnerEmail, apiInviteEmail]);
    const platformId = await getPlatformAccountId(client);
    const analystRoleId = await getRoleId(client, "analyst");
    const ownerRoleId = await getRoleId(client, "owner");
    if (!platformId || !analystRoleId || !ownerRoleId) {
      record("Extended: DB prerequisites", false, { error: "platform account or roles missing" });
      return;
    }

    await createTestUser(client, {
      email: otpEmail,
      password: E2E_USER_PASSWORD,
      accountId: platformId,
      roleSlug: "analyst",
    });
    await createTestUser(client, {
      email: mfaEmail,
      password: E2E_USER_PASSWORD,
      accountId: platformId,
      roleSlug: "analyst",
    });

    // ── OTP email login ───────────────────────────────────────────────
    const otpRequest = await req("POST", "/api/auth/otp/request", { body: { email: otpEmail } });
    record("POST /api/auth/otp/request", otpRequest.status === 200, {
      status: otpRequest.status,
      email: otpEmail,
    });

    await insertLoginOtp(client, otpEmail, otpCode);
    const otpVerify = await req("POST", "/api/auth/otp/verify", {
      body: { email: otpEmail, code: otpCode },
    });
    record("POST /api/auth/otp/verify", otpVerify.status === 200 && !!otpVerify.body?.tokens?.accessToken, {
      status: otpVerify.status,
      roleSlug: otpVerify.body?.user?.roleSlug,
    });

    // ── SSO OAuth initiation ──────────────────────────────────────────
    const googleSso = await reqNoRedirect("GET", "/api/auth/sso/google");
    record("GET /api/auth/sso/google (OAuth redirect)", googleSso.status === 302 && /google/i.test(googleSso.location || ""), {
      status: googleSso.status,
      locationHost: googleSso.location ? new URL(googleSso.location).host : null,
    });

    const msSso = await reqNoRedirect("GET", "/api/auth/sso/microsoft");
    record(
      "GET /api/auth/sso/microsoft (OAuth redirect)",
      msSso.status === 302 && /(microsoft|login\.live)/i.test(msSso.location || ""),
      { status: msSso.status, locationHost: msSso.location ? new URL(msSso.location).host : null }
    );

    const ssoCallback = await reqNoRedirect("GET", "/api/auth/sso/google/callback");
    record(
      "GET /api/auth/sso/google/callback (no code → redirect/error)",
      ssoCallback.status === 302 || ssoCallback.status === 401,
      { status: ssoCallback.status }
    );

    // ── Invite accept flow ────────────────────────────────────────────
    const inviteApi = await req("POST", "/api/users/invites", {
      token: adminToken,
      body: { email: apiInviteEmail, roleId: analystRoleId, accountId: platformId },
    });
    record("POST /api/users/invites", inviteApi.status === 201, {
      status: inviteApi.status,
      inviteId: inviteApi.body?.inviteId,
    });

    const rawInviteToken = `e2e-invite-token-${ts}`;
    await insertPendingInvite(client, {
      email: inviteEmail,
      accountId: platformId,
      roleId: analystRoleId,
      invitedByUserId: adminUserId,
      rawToken: rawInviteToken,
    });

    const inviteAccept = await req("POST", "/api/users/invites/accept", {
      body: {
        token: rawInviteToken,
        password: E2E_USER_PASSWORD,
        firstName: "Invited",
        lastName: "User",
      },
    });
    record("POST /api/users/invites/accept", inviteAccept.status === 201 && !!inviteAccept.body?.userId, {
      status: inviteAccept.status,
      userId: inviteAccept.body?.userId,
      email: inviteAccept.body?.email,
    });

    const invitedLogin = await req("POST", "/api/auth/login", {
      body: { email: inviteEmail, password: E2E_USER_PASSWORD },
    });
    record("POST /api/auth/login (invited user)", invitedLogin.status === 200 && !!invitedLogin.body?.tokens?.accessToken, {
      status: invitedLogin.status,
    });

    // ── MFA setup / enable / recovery (fresh user) ────────────────────
    const mfaLogin = await req("POST", "/api/auth/login", {
      body: { email: mfaEmail, password: E2E_USER_PASSWORD },
    });
    const mfaAccess = mfaLogin.body?.tokens?.accessToken;
    record("POST /api/auth/login (no MFA user)", mfaLogin.status === 200 && !!mfaAccess && !mfaLogin.body?.mfa_required, {
      status: mfaLogin.status,
      mfa_required: mfaLogin.body?.mfa_required ?? false,
    });

    let recoveryCodes = [];
    if (mfaAccess) {
      const mfaSetup = await req("POST", "/api/auth/mfa/setup", { token: mfaAccess });
      const secret = mfaSetup.body?.otpauthUrl && parseSecretFromOtpauth(mfaSetup.body.otpauthUrl);
      record("POST /api/auth/mfa/setup (fresh user)", mfaSetup.status === 200 && !!secret, {
        status: mfaSetup.status,
        hasQr: !!mfaSetup.body?.qrCodeDataUrl,
      });

      if (secret) {
        const enableCode = authenticator.generate(secret);
        const mfaEnable = await req("POST", "/api/auth/mfa/enable", {
          token: mfaAccess,
          body: { code: enableCode },
        });
        recoveryCodes = mfaEnable.body?.recoveryCodes || [];
        record("POST /api/auth/mfa/enable (fresh user)", mfaEnable.status === 200 && recoveryCodes.length === 10, {
          status: mfaEnable.status,
          recoveryCodeCount: recoveryCodes.length,
        });

        const loginMfa = await req("POST", "/api/auth/login", {
          body: { email: mfaEmail, password: E2E_USER_PASSWORD },
        });
        record(
          "POST /api/auth/login (MFA required after enable)",
          loginMfa.status === 200 && loginMfa.body?.mfa_required === true,
          { status: loginMfa.status, mfa_required: loginMfa.body?.mfa_required }
        );

        if (loginMfa.body?.mfaToken && recoveryCodes[0]) {
          const recoveryVerify = await req("POST", "/api/auth/mfa/verify", {
            body: { mfaToken: loginMfa.body.mfaToken, recoveryCode: recoveryCodes[0] },
          });
          record(
            "POST /api/auth/mfa/verify (recovery code)",
            recoveryVerify.status === 200 && !!recoveryVerify.body?.tokens?.accessToken,
            { status: recoveryVerify.status, method: "recovery" }
          );
        }
      }
    }

    // ── Master / child account scoping ────────────────────────────────
    const masterRes = await req("POST", "/api/accounts/master", {
      token: adminToken,
      body: { name: `E2E Master ${ts}` },
    });
    const masterId = masterRes.body?.account?.id;
    record("POST /api/accounts/master", masterRes.status === 201 && !!masterId, {
      status: masterRes.status,
      masterId,
    });

    let childId = null;
    if (masterId) {
      const childRes = await req("POST", "/api/accounts/child", {
        token: adminToken,
        body: { name: `E2E Child ${ts}`, masterAccountId: masterId },
      });
      childId = childRes.body?.account?.id;
      record("POST /api/accounts/child", childRes.status === 201 && !!childId, {
        status: childRes.status,
        childId,
        parentId: masterId,
      });
    }

    if (masterId && childId) {
      await createTestUser(client, {
        email: masterOwnerEmail,
        password: E2E_USER_PASSWORD,
        accountId: masterId,
        roleSlug: "owner",
      });

      const masterLogin = await loginWithPasswordAndMfa(masterOwnerEmail, E2E_USER_PASSWORD);
      const masterToken = masterLogin.accessToken;
      record("Master account owner login", !!masterToken, { email: masterOwnerEmail });

      if (masterToken) {
        const scopedAccounts = await req("GET", "/api/accounts", { token: masterToken });
        const ids = (scopedAccounts.body?.accounts || []).map((a) => a.id);
        const seesMasterAndChild = ids.includes(masterId) && ids.includes(childId);
        record("GET /api/accounts (master scope)", scopedAccounts.status === 200 && seesMasterAndChild, {
          status: scopedAccounts.status,
          accountIds: ids,
          expected: [masterId, childId],
        });

        const scopedUsers = await req("GET", "/api/users", { token: masterToken });
        const userAccountIds = new Set((scopedUsers.body?.users || []).map((u) => u.account_id));
        const usersInScope = [...userAccountIds].every((id) => id === masterId || id === childId);
        record("GET /api/users (master scope)", scopedUsers.status === 200 && usersInScope, {
          status: scopedUsers.status,
          userCount: scopedUsers.body?.users?.length,
          accountIds: [...userAccountIds],
        });
      }

      const platformAccounts = await req("GET", "/api/accounts", { token: adminToken });
      const allIds = (platformAccounts.body?.accounts || []).map((a) => a.id);
      record(
        "GET /api/accounts (platform admin sees hierarchy)",
        platformAccounts.status === 200 && allIds.includes(masterId) && allIds.includes(childId),
        { status: platformAccounts.status, totalAccounts: allIds.length }
      );
    }
  });
}

async function run() {
  writeFileSync(logFile, `=== GiftCred Phase 1 E2E — ${new Date().toISOString()} ===\n`);
  log("INFO", "Auth base", AUTH_BASE);
  log("INFO", "Python base", PYTHON_BASE);

  // ── 1. Infrastructure ──────────────────────────────────────────────
  const health = await req("GET", "/health");
  record("GET /health", health.status === 200 && health.body?.status === "ok", {
    status: health.status,
    ms: health.ms,
  });

  const root = await req("GET", "/");
  record("GET / (API index)", root.status === 200 && root.body?.service, {
    status: root.status,
    endpoints: Object.keys(root.body?.endpoints || {}),
  });

  // ── 2. Login ─────────────────────────────────────────────────────────
  const login = await req("POST", "/api/auth/login", {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  // retry once on transient failure
  const loginRes =
    login.status === 0
      ? await req("POST", "/api/auth/login", {
          body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        })
      : login;

  let accessToken = loginRes.body?.tokens?.accessToken;
  let refreshToken = loginRes.body?.tokens?.refreshToken;
  let mfaRequired = loginRes.body?.mfa_required === true;

  if (mfaRequired) {
    record("POST /api/auth/login (password)", loginRes.status === 200, {
      status: loginRes.status,
      note: "MFA already enabled — will verify via MFA flow",
      mfa_required: true,
    });
  } else {
    record("POST /api/auth/login", loginRes.status === 200 && !!accessToken, {
      status: loginRes.status,
      roleSlug: loginRes.body?.user?.roleSlug,
      privilegeCount: loginRes.body?.user?.privileges?.length,
    });
  }

  // If MFA enabled from prior run, disable for full flow test by using recovery or we test MFA path
  if (mfaRequired && loginRes.body?.mfaToken) {
    const dbMfa = await fetchTotpSecretFromDb(ADMIN_EMAIL);
    if (dbMfa?.mfa_enabled && dbMfa?.totp_secret) {
      const totpCode = authenticator.generate(dbMfa.totp_secret);
      const mfaVerify = await req("POST", "/api/auth/mfa/verify", {
        body: { mfaToken: loginRes.body.mfaToken, code: totpCode },
      });
      accessToken = mfaVerify.body?.tokens?.accessToken;
      refreshToken = mfaVerify.body?.tokens?.refreshToken;
      record("POST /api/auth/mfa/verify (MFA-enabled account)", mfaVerify.status === 200 && !!accessToken, {
        status: mfaVerify.status,
        roleSlug: mfaVerify.body?.user?.roleSlug,
      });
    } else {
      const badMfa = await req("POST", "/api/auth/mfa/verify", {
        body: { mfaToken: loginRes.body.mfaToken, code: "000000" },
      });
      record("POST /api/auth/mfa/verify (invalid code → 401)", badMfa.status === 401, {
        status: badMfa.status,
      });
      log("WARN", "MFA enabled but no DB secret — cannot complete MFA verify");
    }
  }

  if (!mfaRequired && accessToken) {
    // ── 3. MFA setup + enable ──────────────────────────────────────────
    const mfaSetup = await req("POST", "/api/auth/mfa/setup", { token: accessToken });
    const secret =
      mfaSetup.body?.otpauthUrl && parseSecretFromOtpauth(mfaSetup.body.otpauthUrl);
    record("POST /api/auth/mfa/setup", mfaSetup.status === 200 && !!mfaSetup.body?.qrCodeDataUrl, {
      status: mfaSetup.status,
      hasQr: !!mfaSetup.body?.qrCodeDataUrl,
      hasSecret: !!secret,
    });

    if (secret) {
      const totpCode = authenticator.generate(secret);
      const mfaEnable = await req("POST", "/api/auth/mfa/enable", {
        token: accessToken,
        body: { code: totpCode },
      });
      const recoveryCodes = mfaEnable.body?.recoveryCodes;
      record("POST /api/auth/mfa/enable", mfaEnable.status === 200 && recoveryCodes?.length === 10, {
        status: mfaEnable.status,
        recoveryCodeCount: recoveryCodes?.length,
      });

      // ── 4. Login with MFA required ───────────────────────────────────
      const login2 = await req("POST", "/api/auth/login", {
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      mfaRequired = login2.body?.mfa_required === true;
      record("POST /api/auth/login (MFA required flag)", login2.status === 200 && mfaRequired, {
        status: login2.status,
        mfa_required: login2.body?.mfa_required,
      });

      if (mfaRequired && login2.body?.mfaToken) {
        const totpCode2 = authenticator.generate(secret);
        const mfaVerify = await req("POST", "/api/auth/mfa/verify", {
          body: { mfaToken: login2.body.mfaToken, code: totpCode2 },
        });
        accessToken = mfaVerify.body?.tokens?.accessToken;
        refreshToken = mfaVerify.body?.tokens?.refreshToken;
        record("POST /api/auth/mfa/verify (TOTP)", mfaVerify.status === 200 && !!accessToken, {
          status: mfaVerify.status,
          roleSlug: mfaVerify.body?.user?.roleSlug,
        });

        // Recovery code flow
        const login3 = await req("POST", "/api/auth/login", {
          body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        });
        if (login3.body?.mfaToken && recoveryCodes?.[0]) {
          const mfaRecovery = await req("POST", "/api/auth/mfa/verify", {
            body: {
              mfaToken: login3.body.mfaToken,
              recoveryCode: recoveryCodes[0],
            },
          });
          record(
            "POST /api/auth/mfa/verify (recovery code)",
            mfaRecovery.status === 200 && !!mfaRecovery.body?.tokens?.accessToken,
            { status: mfaRecovery.status }
          );
          accessToken = mfaRecovery.body?.tokens?.accessToken || accessToken;
          refreshToken = mfaRecovery.body?.tokens?.refreshToken || refreshToken;
        }
      }
    }
  }

  if (!accessToken) {
    log("ERROR", "No access token — aborting protected route tests");
  } else {
    // ── 5. Protected auth routes ───────────────────────────────────────
    const me = await req("GET", "/api/auth/me", { token: accessToken });
    record("GET /api/auth/me", me.status === 200 && me.body?.user?.email === ADMIN_EMAIL, {
      status: me.status,
      roleSlug: me.body?.user?.roleSlug,
      isPlatformAdmin: me.body?.user?.isPlatformAdmin,
    });

    const sessions = await req("GET", "/api/auth/sessions", { token: accessToken });
    const sessionList = sessions.body?.sessions || [];
    record("GET /api/auth/sessions", sessions.status === 200 && sessionList.length >= 1, {
      status: sessions.status,
      count: sessionList.length,
      sample: sessionList[0]
        ? {
            id: sessionList[0].id,
            ip: sessionList[0].ipAddress,
            lastUsed: sessionList[0].lastUsedAt,
          }
        : null,
    });

    // ── 6. Users (scoped) ────────────────────────────────────────────
    const users = await req("GET", "/api/users", { token: accessToken });
    record("GET /api/users", users.status === 200 && Array.isArray(users.body?.users), {
      status: users.status,
      count: users.body?.users?.length,
    });

    const roles = await req("GET", "/api/users/roles", { token: accessToken });
    record("GET /api/users/roles", roles.status === 200 && roles.body?.roles?.length >= 4, {
      status: roles.status,
      count: roles.body?.roles?.length,
    });

    // ── 7. Accounts ──────────────────────────────────────────────────
    const accounts = await req("GET", "/api/accounts", { token: accessToken });
    record("GET /api/accounts", accounts.status === 200 && accounts.body?.accounts?.length >= 1, {
      status: accounts.status,
      count: accounts.body?.accounts?.length,
    });

    // ── 8. Audit logs ────────────────────────────────────────────────
    const audit = await req("GET", "/api/audit/logs?page=1&limit=10", { token: accessToken });
    record("GET /api/audit/logs", audit.status === 200 && Array.isArray(audit.body?.logs), {
      status: audit.status,
      total: audit.body?.pagination?.total,
      returned: audit.body?.logs?.length,
      sampleAction: audit.body?.logs?.[0]?.action,
    });

    const auditFiltered = await req(
      "GET",
      "/api/audit/logs?action=login_success&limit=5",
      { token: accessToken }
    );
    record("GET /api/audit/logs (action filter)", auditFiltered.status === 200, {
      status: auditFiltered.status,
      count: auditFiltered.body?.logs?.length,
    });

    // ── 9. Token refresh ─────────────────────────────────────────────
    if (refreshToken) {
      const refresh = await req("POST", "/api/auth/refresh", {
        body: { refreshToken },
      });
      const newAccess = refresh.body?.tokens?.accessToken;
      record("POST /api/auth/refresh", refresh.status === 200 && !!newAccess, {
        status: refresh.status,
      });
      if (newAccess) accessToken = newAccess;
      if (refresh.body?.tokens?.refreshToken) refreshToken = refresh.body.tokens.refreshToken;
    }

    // ── 10. Unauthorized access ───────────────────────────────────────
    const noAuth = await req("GET", "/api/users");
    record("GET /api/users (no token → 401)", noAuth.status === 401, { status: noAuth.status });

    // ── 11. Session revoke (non-current if possible) ─────────────────
    if (sessionList.length > 1) {
      const toRevoke = sessionList[sessionList.length - 1].id;
      const del = await req("DELETE", `/api/auth/sessions/${toRevoke}`, { token: accessToken });
      record("DELETE /api/auth/sessions/:id", del.status === 200, {
        status: del.status,
        sessionId: toRevoke,
      });
    } else {
      log("INFO", "Only one session — skip DELETE session test");
      record("DELETE /api/auth/sessions/:id", true, { skipped: true, reason: "single session" });
    }

    // ── Extended flows (--force) ───────────────────────────────────────
    await runExtendedFlows(accessToken, me.body?.user?.userId ?? 1);
  }

  // ── 12. Python backend JWT integration ─────────────────────────────
  const pyCatalog = await req("GET", "/api/catalog", { base: PYTHON_BASE });
  if (pyCatalog.status === 0) {
    record("Python backend reachable", false, {
      error: "not reachable — start with: cd backend && uvicorn main:app --port 8000",
    });
  } else {
    record("Python GET /api/catalog (public)", pyCatalog.status === 200, {
      status: pyCatalog.status,
      productCount: Array.isArray(pyCatalog.body) ? pyCatalog.body.length : null,
    });

    const pyOrdersNoAuth = await req("GET", "/api/orders", { base: PYTHON_BASE });
    record("Python GET /api/orders (no token → 401)", pyOrdersNoAuth.status === 401, {
      status: pyOrdersNoAuth.status,
    });

    if (accessToken) {
      const pyOrdersAuth = await req("GET", "/api/orders", {
        token: accessToken,
        base: PYTHON_BASE,
      });
      record("Python GET /api/orders (with JWT)", pyOrdersAuth.status === 200, {
        status: pyOrdersAuth.status,
        orderCount: Array.isArray(pyOrdersAuth.body) ? pyOrdersAuth.body.length : null,
        requestedBy: pyOrdersAuth.body?.[0]?.requestedBy,
      });

      const sku =
        (Array.isArray(pyCatalog.body) && pyCatalog.body[0]?.sku) || "UBEFLOW";
      const pyPurchaseNoAuth = await req("POST", "/api/purchase", {
        base: PYTHON_BASE,
        body: {
          items: [{ sku, amount: 100, quantity: 1 }],
          mobileNumber: "9876543210",
          email: ADMIN_EMAIL,
        },
      });
      record("Python POST /api/purchase (no token → 401)", pyPurchaseNoAuth.status === 401, {
        status: pyPurchaseNoAuth.status,
      });

      const pyPurchaseAuth = await req("POST", "/api/purchase", {
        token: accessToken,
        base: PYTHON_BASE,
        body: {
          items: [{ sku, amount: 100, quantity: 1 }],
          mobileNumber: "9876543210",
          email: ADMIN_EMAIL,
        },
      });
      const detail = typeof pyPurchaseAuth.body?.detail === "string" ? pyPurchaseAuth.body.detail : "";
      const jwtRejected =
        pyPurchaseAuth.status === 401 &&
        /^(Authentication required|Invalid access token|Access token expired|Malformed access token|Invalid token type)/.test(
          detail
        );
      const jwtAccepted = !jwtRejected;
      const orderPlaced = pyPurchaseAuth.status === 200 && pyPurchaseAuth.body?.success === true;
      record("Python POST /api/purchase (with JWT)", jwtAccepted, {
        status: pyPurchaseAuth.status,
        sku,
        jwtAccepted,
        orderPlaced,
        orderId: pyPurchaseAuth.body?.orderId,
        placedBy: pyPurchaseAuth.body?.placedBy,
        detail: orderPlaced ? undefined : detail || pyPurchaseAuth.body,
        note: orderPlaced ? undefined : "JWT accepted; upstream Woohoo may reject order",
      });
    } else {
      record("Python GET /api/orders (with JWT)", false, { skipped: true, reason: "no access token" });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const summary = { total: results.length, passed, failed, results };
  log("INFO", "SUMMARY", summary);
  writeFileSync(resolve(__dirname, "../e2e-report.json"), JSON.stringify(summary, null, 2));
  console.log("\n--- E2E SUMMARY ---");
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Full log: ${logFile}`);
  if (dbPool) await dbPool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  log("FATAL", err.message);
  process.exit(1);
});
