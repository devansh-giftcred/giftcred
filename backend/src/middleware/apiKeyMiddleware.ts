import type { Response, NextFunction } from "express";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { B2B_SYSTEM_USER_ID, verifyApiKey } from "../api-keys/api-keys.service.js";
import { extractClientIp } from "../auth/crypto.utils.js";
import { isIpAllowed } from "../lib/ipUtils.js";

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

  const clientIp = extractClientIp(req);
  if (!isIpAllowed(clientIp, verified.ipAllowlist)) {
    res.status(403).json({ error: "Access denied from this IP address." });
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
    ipAllowlist: verified.ipAllowlist,
    isApiKeyAuth: true,
    apiKeyId: verified.keyId,
  };

  next();
}
