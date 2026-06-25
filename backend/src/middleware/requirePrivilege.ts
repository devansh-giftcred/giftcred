import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "../types/auth.js";

export function requirePrivilege(...required: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    if (req.auth.isPlatformAdmin) {
      next();
      return;
    }

    const hasAll = required.every(
      (priv) => req.auth!.privileges.includes(priv)
    );

    if (!hasAll) {
      res.status(403).json({
        error: "Insufficient permissions.",
        required,
      });
      return;
    }

    next();
  };
}

export function requirePlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth?.isPlatformAdmin) {
    res.status(403).json({ error: "Platform admin access required." });
    return;
  }
  next();
}
