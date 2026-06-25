import type { Request } from "express";

export type AccountType = "platform" | "master" | "child";

export type UserStatus = "pending" | "active" | "suspended" | "deactivated";

export interface AuthContext {
  userId: number;
  email: string;
  accountId: number;
  accountType: AccountType;
  roleId: number;
  roleSlug: string;
  privileges: string[];
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
  mfaEnforcementActive: boolean;
  isApiKeyAuth?: boolean;
  apiKeyId?: number;
}

export interface AccessTokenPayload {
  sub: number;
  email: string;
  accountId: number;
  roleId: number;
  roleSlug: string;
  privileges: string[];
  sessionId: number;
  type: "access";
}

export interface StepUpTokenPayload {
  sub: number;
  accountId: number;
  type: "step_up";
}

export interface MfaPendingTokenPayload {
  sub: number;
  email: string;
  accountId: number;
  roleId: number;
  type: "mfa_pending";
}

export interface RefreshTokenPayload {
  sub: number;
  sessionId: number;
  type: "refresh";
}

export type AuthedRequest = Request & {
  auth?: AuthContext;
  clientIp?: string;
};

export interface DeviceInfo {
  browser?: string;
  os?: string;
  device?: string;
  raw?: string;
}

export interface TokenRoleContext {
  roleSlug: string;
  privileges: string[];
}
