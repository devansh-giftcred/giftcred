import { Router } from "express";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { extractClientIp } from "../auth/crypto.utils.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { requirePrivilege, requirePlatformAdmin } from "../middleware/requirePrivilege.js";
import {
  createChildAccount,
  createMasterAccount,
  getAccountById,
  listAccountsInScope,
} from "./accounts.service.js";

export const accountsRouter = Router();

accountsRouter.use(authMiddleware);

accountsRouter.get("/", requirePrivilege("view_accounts"), async (req: AuthedRequest, res, next) => {
  try {
    const accounts = await withClient((client) =>
      listAccountsInScope(client, {
        accountId: req.auth!.accountId,
        accountType: req.auth!.accountType,
        isPlatformAdmin: req.auth!.isPlatformAdmin,
      })
    );
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

accountsRouter.get("/:accountId", requirePrivilege("view_accounts"), async (req: AuthedRequest, res, next) => {
  try {
    const accountId = Number(req.params.accountId);
    const account = await withClient((client) => getAccountById(client, accountId));
    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json({ account });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post("/master", requirePlatformAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Account name is required." });
      return;
    }
    const account = await withClient((client) =>
      createMasterAccount(client, {
        name,
        actingUserId: req.auth!.userId,
        ipAddress: extractClientIp(req),
      })
    );
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post("/child", requirePrivilege("manage_accounts"), async (req: AuthedRequest, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const masterAccountId = Number(req.body?.masterAccountId ?? req.auth!.accountId);
    if (!name) {
      res.status(400).json({ error: "Account name is required." });
      return;
    }
    const account = await withClient((client) =>
      createChildAccount(client, {
        name,
        masterAccountId,
        actingUserId: req.auth!.userId,
        ipAddress: extractClientIp(req),
      })
    );
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});
