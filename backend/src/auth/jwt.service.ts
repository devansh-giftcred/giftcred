import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type {
  AccessTokenPayload,
  MfaPendingTokenPayload,
  StepUpTokenPayload,
  TokenRoleContext,
} from "../types/auth.js";

const MFA_PENDING_TTL_MINUTES = 5;
const STEP_UP_TTL_MINUTES = 5;

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "type"> & TokenRoleContext
): string {
  const full: AccessTokenPayload = { ...payload, type: "access" };
  return jwt.sign(full, config.jwtSecret(), {
    expiresIn: `${config.jwtAccessTtlMinutes()}m`,
  });
}

export function signStepUpToken(userId: number, accountId: number): string {
  const full: StepUpTokenPayload = { sub: userId, accountId, type: "step_up" };
  return jwt.sign(full, config.jwtSecret(), {
    expiresIn: `${STEP_UP_TTL_MINUTES}m`,
  });
}

export function verifyStepUpToken(token: string): StepUpTokenPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret()) as unknown as StepUpTokenPayload;
    if (payload.type !== "step_up") return null;
    return payload;
  } catch {
    return null;
  }
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
  refreshToken: string,
  sessionId: number
): TokenPair {
  return {
    accessToken: signAccessToken({
      sub: userId,
      email,
      accountId,
      roleId,
      roleSlug: role.roleSlug,
      privileges: role.privileges,
      sessionId,
    }),
    refreshToken,
    accessExpiresIn: config.jwtAccessTtlMinutes() * 60,
  };
}
