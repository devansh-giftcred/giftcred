import { Router, type Response, type NextFunction } from "express";
import passport from "passport";
import type { PoolClient } from "pg";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { extractClientIp } from "../auth/crypto.utils.js";
import {
  AuthError,
  buildAuthContextForUser,
  completeLoginAfterMfa,
  loginWithPassword,
  logout,
  refreshAccessToken,
} from "../auth/login.service.js";
import { enableMfa, setupMfa, verifyMfaForLogin } from "../auth/mfa.service.js";
import { verifyMfaPendingToken } from "../auth/jwt.service.js";
import { requestLoginOtp, verifyLoginOtp } from "../auth/otp.service.js";
import { findUserBySsoIdentity, linkSsoIdentity, type SsoProfile } from "../auth/sso.service.js";
import { issueSessionTokens } from "../auth/login.helpers.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { invalidateRoleCache, resolveUserRole } from "../redis/roleCache.js";
import { findActiveSessionByToken, findActiveSessions, revokeSessionForUser } from "../auth/session.service.js";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { config } from "../config.js";

export const authRouter = Router();

function clientMeta(req: AuthedRequest) {
  return {
    ipAddress: extractClientIp(req),
    userAgent: req.headers["user-agent"],
  };
}

authRouter.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "");
    const password = String(req.body?.password ?? "");
    const result = await withClient((client) =>
      loginWithPassword(client, email, password, clientMeta(req))
    );
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post("/otp/request", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "");
    await withClient((client) => requestLoginOtp(client, email, clientMeta(req)));
    res.json({ message: "OTP sent if account exists." });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post("/otp/verify", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "");
    const code = String(req.body?.code ?? "");
    const result = await withClient(async (client) => {
      const user = await verifyLoginOtp(client, email, code, clientMeta(req));
      await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
      await invalidateRoleCache(user.id);
      const role = await resolveUserRole(user.id);
      if (!role) throw new AuthError("Unable to resolve user role.", 500);
      const { tokens } = await issueSessionTokens(
        client,
        user,
        { roleSlug: role.roleSlug, privileges: role.privileges },
        clientMeta(req)
      );
      return {
        tokens,
        user: {
          userId: role.userId,
          email: user.email,
          accountId: role.accountId,
          accountType: role.accountType,
          roleId: role.roleId,
          roleSlug: role.roleSlug,
          privileges: role.privileges,
          isPlatformAdmin: role.isPlatformAdmin,
        },
      };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const refreshToken = String(req.body?.refreshToken ?? "");
    const result = await withClient((client) =>
      refreshAccessToken(client, refreshToken, clientMeta(req))
    );
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post("/logout", authMiddleware, async (req: AuthedRequest, res, next) => {
  try {
    const refreshToken = String(req.body?.refreshToken ?? "");
    await withClient(async (client) => {
      const session = refreshToken
        ? await findActiveSessionByToken(client, refreshToken)
        : null;
      if (session && req.auth) {
        await logout(client, session.id, req.auth.userId, req.auth.accountId, clientMeta(req));
      }
    });
    res.json({ message: "Logged out." });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", authMiddleware, async (req: AuthedRequest, res) => {
  res.json({ user: req.auth });
});

authRouter.post("/mfa/setup", authMiddleware, async (req: AuthedRequest, res, next) => {
  try {
    const result = await withClient((client) =>
      setupMfa(client, req.auth!.userId, req.auth!.email)
    );
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post("/mfa/enable", authMiddleware, async (req: AuthedRequest, res, next) => {
  try {
    const totpCode = String(req.body?.code ?? req.body?.totpCode ?? "");
    if (!totpCode) {
      res.status(400).json({ error: "TOTP code is required." });
      return;
    }
    const result = await withClient((client) =>
      enableMfa(client, req.auth!.userId, totpCode, {
        ...clientMeta(req),
        accountId: req.auth!.accountId,
      })
    );
    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.post("/mfa/verify", async (req, res, next) => {
  try {
    const mfaToken = String(req.body?.mfaToken ?? "");
    const totpCode = req.body?.code ? String(req.body.code) : undefined;
    const recoveryCode = req.body?.recoveryCode ? String(req.body.recoveryCode) : undefined;

    if (!mfaToken) {
      res.status(400).json({ error: "mfaToken is required." });
      return;
    }

    const payload = verifyMfaPendingToken(mfaToken);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired MFA token." });
      return;
    }

    const result = await withClient(async (client) => {
      await verifyMfaForLogin(client, payload.sub, { totpCode, recoveryCode });
      return completeLoginAfterMfa(client, payload.sub, clientMeta(req));
    });

    res.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

authRouter.get("/sessions", authMiddleware, async (req: AuthedRequest, res, next) => {
  try {
    const sessions = await withClient((client) =>
      findActiveSessions(client, req.auth!.userId)
    );
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        ipAddress: s.ip_address,
        userAgent: s.user_agent,
        deviceInfo: s.device_info,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.delete("/sessions/:id", authMiddleware, async (req: AuthedRequest, res, next) => {
  try {
    const sessionId = Number(req.params.id);
    await withClient(async (client) => {
      await revokeSessionForUser(client, req.auth!.userId, sessionId);
      await writeAuditLog(client, {
        actingUserId: req.auth!.userId,
        accountId: req.auth!.accountId,
        action: AuditAction.SESSION_REVOKED,
        newValue: { sessionId },
        ipAddress: clientMeta(req).ipAddress,
        userAgent: clientMeta(req).userAgent,
      });
    });
    res.json({ message: "Session revoked." });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Google SSO
authRouter.get("/sso/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));

authRouter.get(
  "/sso/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${config.frontendUrl()}/login?error=sso` }),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const profile = req.user as SsoProfile;
      const payload = await withClient((client) => handleSsoLogin(client, profile, clientMeta(req)));
      res.redirect(
        `${config.frontendUrl()}/auth/callback?accessToken=${encodeURIComponent(payload.tokens.accessToken)}&refreshToken=${encodeURIComponent(payload.tokens.refreshToken)}`
      );
    } catch (err) {
      next(err);
    }
  }
);

// Microsoft SSO
authRouter.get("/sso/microsoft", passport.authenticate("microsoft", { session: false }));

authRouter.get(
  "/sso/microsoft/callback",
  passport.authenticate("microsoft", { session: false, failureRedirect: `${config.frontendUrl()}/login?error=sso` }),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const profile = req.user as SsoProfile;
      const payload = await withClient((client) => handleSsoLogin(client, profile, clientMeta(req)));
      res.redirect(
        `${config.frontendUrl()}/auth/callback?accessToken=${encodeURIComponent(payload.tokens.accessToken)}&refreshToken=${encodeURIComponent(payload.tokens.refreshToken)}`
      );
    } catch (err) {
      next(err);
    }
  }
);

async function handleSsoLogin(
  client: PoolClient,
  profile: SsoProfile,
  meta: { ipAddress?: string; userAgent?: string }
) {
  type SsoUser = {
    user_id: number;
    email: string;
    account_id: number;
    role_id: number;
    status: string;
  };

  let user: SsoUser | null = await findUserBySsoIdentity(client, profile.provider, profile.providerUserId);

  if (!user) {
    const byEmail = await client.query<{
      id: number;
      email: string;
      account_id: number;
      role_id: number;
      status: string;
    }>(`SELECT id, email, account_id, role_id, status FROM users WHERE email = $1`, [profile.email]);
    const row = byEmail.rows[0];
    user = row
      ? {
          user_id: row.id,
          email: row.email,
          account_id: row.account_id,
          role_id: row.role_id,
          status: row.status,
        }
      : null;
  }

  // Auto-create user if not found — open SSO registration
  if (!user) {
    // Get platform account + default 'analyst' role
    const accountRes = await client.query<{ id: number }>(
      `SELECT id FROM accounts WHERE account_type = 'master' ORDER BY id ASC LIMIT 1`
    );
    const platformRes = await client.query<{ id: number }>(
      `SELECT id FROM accounts WHERE account_type = 'platform' LIMIT 1`
    );
    const accountId = accountRes.rows[0]?.id ?? platformRes.rows[0]?.id;

    const roleRes = await client.query<{ id: number }>(
      `SELECT id FROM roles WHERE slug = 'analyst' AND account_id IS NULL LIMIT 1`
    );
    const roleId = roleRes.rows[0]?.id;

    if (!accountId || !roleId) {
      throw new AuthError("Platform not configured. Contact administrator.", 500);
    }

    const newUser = await client.query<{
      id: number; email: string; account_id: number; role_id: number; status: string;
    }>(
      `INSERT INTO users (account_id, role_id, email, first_name, last_name, status, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW())
       RETURNING id, email, account_id, role_id, status`,
      [accountId, roleId, profile.email, profile.firstName ?? "", profile.lastName ?? ""]
    );

    user = {
      user_id: newUser.rows[0].id,
      email: newUser.rows[0].email,
      account_id: newUser.rows[0].account_id,
      role_id: newUser.rows[0].role_id,
      status: newUser.rows[0].status,
    };
  }

  if (user.status !== "active") {
    throw new AuthError("Your account has been suspended. Contact administrator.", 403);
  }

  await linkSsoIdentity(client, user.user_id, profile, {
    ...meta,
    accountId: user.account_id,
  });

  await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.user_id]);
  await invalidateRoleCache(user.user_id);

  const role = await resolveUserRole(user.user_id);
  if (!role) throw new AuthError("Unable to resolve user role.", 500);

  const { tokens } = await issueSessionTokens(
    client,
    {
      id: user.user_id,
      email: user.email,
      account_id: user.account_id,
      role_id: user.role_id,
    },
    { roleSlug: role.roleSlug, privileges: role.privileges },
    meta
  );

  await writeAuditLog(client, {
    actingUserId: user.user_id,
    accountId: user.account_id,
    action: AuditAction.LOGIN_SUCCESS,
    newValue: { method: "sso", provider: profile.provider },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return {
    tokens,
    user: role,
  };
}
