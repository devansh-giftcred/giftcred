import type { Response, NextFunction } from "express";
import { withClient } from "../db.js";
import { verifyAccessToken } from "../auth/jwt.service.js";
import { buildAuthContextForUser } from "../auth/login.service.js";
import { invalidateRoleCache } from "../redis/roleCache.js";
import {
  clearSessionActivity,
  isSessionActive,
  refreshSessionActivity,
  revokeSession,
} from "../auth/session.service.js";
import type { AuthedRequest } from "../types/auth.js";

const MFA_SETUP_ALLOWED_PATHS = new Set([
  "/api/auth/mfa/setup",
  "/api/auth/mfa/enable",
  "/api/auth/logout",
]);

function isMfaSetupAllowedPath(req: AuthedRequest): boolean {
  const path = req.originalUrl.split("?")[0];
  return MFA_SETUP_ALLOWED_PATHS.has(path);
}

export async function authMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.auth?.isApiKeyAuth) {
    next();
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired access token." });
    return;
  }

  if (!payload.sessionId) {
    res.status(401).json({ error: "Invalid or expired access token." });
    return;
  }

  const activityActive = await refreshSessionActivity(payload.sessionId);
  if (!activityActive) {
    await withClient(async (client) => {
      await revokeSession(client, payload.sessionId);
      await invalidateRoleCache(payload.sub);
      await clearSessionActivity(payload.sessionId);
    });
    res.status(401).json({ error: "Session timed out due to inactivity." });
    return;
  }

  const sessionValid = await withClient((client) =>
    isSessionActive(client, payload.sessionId, payload.sub)
  );
  if (!sessionValid) {
    await invalidateRoleCache(payload.sub);
    await clearSessionActivity(payload.sessionId);
    res.status(401).json({ error: "Session expired or revoked." });
    return;
  }

  const auth = await buildAuthContextForUser(payload.sub);
  if (!auth) {
    res.status(401).json({ error: "User account not found or inactive." });
    return;
  }

  if (
    auth.mfaEnforcementActive &&
    !auth.mfaEnabled &&
    !isMfaSetupAllowedPath(req)
  ) {
    res.status(403).json({ error: "MFA setup required" });
    return;
  }

  req.auth = auth;
  next();
}
