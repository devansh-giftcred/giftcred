import { Router } from "express";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { requirePrivilege } from "../middleware/requirePrivilege.js";
import { queryAuditLogs } from "./audit.service.js";

export const auditRouter = Router();

auditRouter.use(authMiddleware);
auditRouter.use(requirePrivilege("view_audit_logs"));

auditRouter.get("/logs", async (req: AuthedRequest, res, next) => {
  try {
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;
    const actingUserId = req.query.actingUserId ? Number(req.query.actingUserId) : undefined;

    const result = await withClient((client) =>
      queryAuditLogs(client, req.auth!, {
        page,
        limit,
        startDate,
        endDate,
        action,
        actingUserId,
      })
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});
