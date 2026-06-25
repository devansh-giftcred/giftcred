import { Router } from "express";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { extractClientIp } from "../auth/crypto.utils.js";
import { AuthError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { requirePrivilege } from "../middleware/requirePrivilege.js";
import {
  acceptInvite,
  assignUserRole,
  listRoles,
  listUsersInScopedAccounts,
  sendUserInvite,
} from "./invite.service.js";

export const usersRouter = Router();

function clientMeta(req: AuthedRequest) {
  return {
    ipAddress: extractClientIp(req),
    userAgent: req.headers["user-agent"],
  };
}

usersRouter.post("/invites/accept", async (req, res, next) => {
  try {
    const token = String(req.body?.token ?? "");
    const password = String(req.body?.password ?? "");
    const firstName = String(req.body?.firstName ?? "");
    const lastName = String(req.body?.lastName ?? "");

    if (!token || password.length < 8) {
      res.status(400).json({ error: "Valid token and password (min 8 chars) required." });
      return;
    }

    const result = await withClient((client) =>
      acceptInvite(client, { token, password, firstName, lastName, ...clientMeta(req) })
    );
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

usersRouter.use(authMiddleware);

usersRouter.get("/", requirePrivilege("view_users"), async (req: AuthedRequest, res, next) => {
  try {
    const users = await withClient((client) => listUsersInScopedAccounts(client, req.auth!));
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

usersRouter.get("/roles", requirePrivilege("view_roles"), async (req: AuthedRequest, res, next) => {
  try {
    const roles = await withClient((client) => listRoles(client, req.auth!.accountId));
    res.json({ roles });
  } catch (err) {
    next(err);
  }
});

usersRouter.post("/invites", requirePrivilege("invite_user"), async (req: AuthedRequest, res, next) => {
  try {
    const email = String(req.body?.email ?? "");
    const roleId = Number(req.body?.roleId);
    const accountId = Number(req.body?.accountId ?? req.auth!.accountId);

    if (!email || !roleId) {
      res.status(400).json({ error: "email and roleId are required." });
      return;
    }

    const invite = await withClient((client) =>
      sendUserInvite(client, {
        accountId,
        invitedByUserId: req.auth!.userId,
        email,
        roleId,
        ...clientMeta(req),
      })
    );
    res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});

usersRouter.patch(
  "/:userId/role",
  requirePrivilege("assign_roles"),
  async (req: AuthedRequest, res, next) => {
    try {
      const targetUserId = Number(req.params.userId);
      const newRoleId = Number(req.body?.roleId);
      if (!newRoleId) {
        res.status(400).json({ error: "roleId is required." });
        return;
      }

      await withClient((client) =>
        assignUserRole(client, {
          targetUserId,
          newRoleId,
          actingUserId: req.auth!.userId,
          accountId: req.auth!.accountId,
          ...clientMeta(req),
        })
      );
      res.json({ message: "Role updated." });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);
