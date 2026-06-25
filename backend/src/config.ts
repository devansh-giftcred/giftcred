import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
for (const path of [resolve(root, ".env"), resolve(root, "../.env")]) {
  if (existsSync(path)) dotenv.config({ path });
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: () => optionalInt("PORT", 3001),
  nodeEnv: () => optionalEnv("NODE_ENV", "development"),
  isProd: () => config.nodeEnv() === "production",
  appUrl: () => optionalEnv("APP_URL", "http://localhost:3001"),
  frontendUrl: () => optionalEnv("FRONTEND_URL", "http://localhost:5173"),
  corsOrigins: () => {
    const raw = process.env.CORS_ORIGINS?.trim();
    if (!raw) return ["http://localhost:5173"];
    return raw.split(",").map((o) => o.trim()).filter(Boolean);
  },

  databaseUrl: () => requireEnv("DATABASE_URL"),
  redisUrl: () => optionalEnv("REDIS_URL", "redis://localhost:6379"),
  redisOptional: () =>
    process.env.REDIS_OPTIONAL === "true" || (!config.isProd() && process.env.REDIS_OPTIONAL !== "false"),

  jwtSecret: () => requireEnv("JWT_SECRET"),
  jwtRefreshSecret: () => requireEnv("JWT_REFRESH_SECRET"),
  jwtAccessTtlMinutes: () => optionalInt("JWT_ACCESS_TTL_MINUTES", 15),
  jwtRefreshTtlDays: () => optionalInt("JWT_REFRESH_TTL_DAYS", 30),

  woohooConsumerKey: () => requireEnv("WOOHOO_CONSUMER_KEY"),
  woohooConsumerSecret: () => requireEnv("WOOHOO_CONSUMER_SECRET"),
  woohooUsername: () => requireEnv("WOOHOO_USERNAME"),
  woohooPassword: () => requireEnv("WOOHOO_PASSWORD"),
  woohooBaseUrl: () => optionalEnv("WOOHOO_BASE_URL", "https://sandbox.woohoo.in").replace(/\/$/, ""),
  woohooRequestTimeout: () => optionalInt("WOOHOO_REQUEST_TIMEOUT", 30) * 1000,
  woohooMaxRetries: () => optionalInt("WOOHOO_MAX_RETRIES", 3),

  gmailUser: () => requireEnv("GMAIL_USER"),
  gmailAppPassword: () => requireEnv("GMAIL_APP_PASSWORD"),
  emailFrom: () => optionalEnv("EMAIL_FROM", `GiftCred <${process.env.GMAIL_USER ?? "noreply@giftcred.com"}>`),

  googleClientId: () => optionalEnv("GOOGLE_CLIENT_ID", ""),
  googleClientSecret: () => optionalEnv("GOOGLE_CLIENT_SECRET", ""),
  googleCallbackUrl: () =>
    optionalEnv("GOOGLE_CALLBACK_URL", `${config.appUrl()}/api/auth/sso/google/callback`),

  microsoftClientId: () => optionalEnv("MICROSOFT_CLIENT_ID", ""),
  microsoftClientSecret: () => optionalEnv("MICROSOFT_CLIENT_SECRET", ""),
  microsoftTenantId: () => optionalEnv("MICROSOFT_TENANT_ID", "common"),
  microsoftCallbackUrl: () =>
    optionalEnv("MICROSOFT_CALLBACK_URL", `${config.appUrl()}/api/auth/sso/microsoft/callback`),

  inviteTokenTtlHours: () => optionalInt("INVITE_TOKEN_TTL_HOURS", 48),
  otpTtlMinutes: () => optionalInt("OTP_TTL_MINUTES", 10),
  roleCacheTtlSeconds: () => optionalInt("ROLE_CACHE_TTL_SECONDS", 1800),
};
