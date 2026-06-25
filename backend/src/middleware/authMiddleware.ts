import type { Response, NextFunction } from "express";
import { verifyAccessToken } from "../auth/jwt.service.js";
import { buildAuthContextForUser } from "../auth/login.service.js";
import type { AuthedRequest } from "../types/auth.js";

export async function authMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
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

  const auth = await buildAuthContextForUser(payload.sub);
  if (!auth) {
    res.status(401).json({ error: "User account not found or inactive." });
    return;
  }

  req.auth = auth;
  next();
}
