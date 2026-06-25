import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { AccessTokenPayload, MfaPendingTokenPayload, TokenRoleContext } from "../types/auth.js";

const MFA_PENDING_TTL_MINUTES = 5;

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "type"> & TokenRoleContext
): string {
  const full: AccessTokenPayload = { ...payload, type: "access" };
  return jwt.sign(full, config.jwtSecret(), {
    expiresIn: `${config.jwtAccessTtlMinutes()}m`,
  });
}

export function signMfaPendingToken(
  payload: Omit<MfaPendingTokenPayload, "type">
): string {
  const full: MfaPendingTokenPayload = { ...payload, type: "mfa_pending" };
  return jwt.sign(full, config.jwtSecret(), {
    expiresIn: `${MFA_PENDING_TTL_MINUTES}m`,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret()) as unknown as AccessTokenPayload;
    if (payload.type !== "access") return null;
    return payload;
  } catch {
    return null;
  }
}

export function verifyMfaPendingToken(token: string): MfaPendingTokenPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret()) as unknown as MfaPendingTokenPayload;
    if (payload.type !== "mfa_pending") return null;
    return payload;
  } catch {
    return null;
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

export function issueTokenPair(
  userId: number,
  email: string,
  accountId: number,
  roleId: number,
  role: TokenRoleContext,
  refreshToken: string
): TokenPair {
  return {
    accessToken: signAccessToken({
      sub: userId,
      email,
      accountId,
      roleId,
      roleSlug: role.roleSlug,
      privileges: role.privileges,
    }),
    refreshToken,
    accessExpiresIn: config.jwtAccessTtlMinutes() * 60,
  };
}
