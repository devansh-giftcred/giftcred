import type { Response, NextFunction } from "express";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { B2B_SYSTEM_USER_ID, verifyApiKey } from "../api-keys/api-keys.service.js";

export async function apiKeyMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.auth) {
    next();
    return;
  }

  const rawKey = String(req.headers["x-api-key"] ?? "").trim();
  if (!rawKey) {
    next();
    return;
  }

  const verified = await withClient((client) => verifyApiKey(client, rawKey));
  if (!verified) {
    res.status(401).json({ error: "Invalid API key." });
    return;
  }

  req.auth = {
    userId: B2B_SYSTEM_USER_ID,
    email: "b2b-api@system.giftcred",
    accountId: verified.accountId,
    accountType: verified.accountType,
    roleId: 0,
    roleSlug: "b2b_api",
    privileges: verified.scopes,
    isPlatformAdmin: false,
    mfaEnabled: true,
    mfaEnforcementActive: false,
    isApiKeyAuth: true,
    apiKeyId: verified.keyId,
  };

  next();
}
