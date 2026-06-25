import { createHash, randomBytes } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function generateOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function extractClientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? "0.0.0.0";
}

export function parseDeviceInfo(userAgent?: string) {
  return {
    raw: userAgent ?? "",
    browser: userAgent ?? "unknown",
    os: "unknown",
    device: "unknown",
  };
}
