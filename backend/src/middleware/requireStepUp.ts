import type { Response, NextFunction } from "express";
import { verifyStepUpToken } from "../auth/jwt.service.js";
import type { AuthedRequest } from "../types/auth.js";

export function requireStepUp(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const token = String(req.headers["x-step-up-token"] ?? "").trim();
  if (!token) {
    res.status(401).json({ error: "Step-up MFA required" });
    return;
  }

  const payload = verifyStepUpToken(token);
  if (!payload || payload.sub !== req.auth.userId || payload.accountId !== req.auth.accountId) {
    res.status(401).json({ error: "Step-up MFA required" });
    return;
  }

  next();
}
