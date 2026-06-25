import type { PoolClient } from "pg";
import { generateSecureToken } from "./crypto.utils.js";
import { issueTokenPair } from "./jwt.service.js";
import type { TokenRoleContext } from "../types/auth.js";
import { createSession } from "./session.service.js";

export async function issueSessionTokens(
  client: PoolClient,
  user: { id: number; email: string; account_id: number; role_id: number },
  role: TokenRoleContext,
  meta: { ipAddress?: string; userAgent?: string }
) {
  const refreshToken = generateSecureToken(48);
  const sessionId = await createSession(client, user.id, refreshToken, meta);
  const tokens = issueTokenPair(
    user.id,
    user.email,
    user.account_id,
    user.role_id,
    role,
    refreshToken,
    sessionId
  );
  return { tokens, sessionId };
}
