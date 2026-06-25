import { Router } from "express";
import { withClient } from "../db.js";
import type { AuthedRequest } from "../types/auth.js";
import { AuthError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys.service.js";

export const apiKeysRouter = Router();

apiKeysRouter.use(authMiddleware);

apiKeysRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const name = String(req.body?.name ?? "");
    const scopes = Array.isArray(req.body?.scopes)
      ? req.body.scopes.map((s: unknown) => String(s))
      : [];

    const result = await withClient((client) =>
      createApiKey(client, req.auth!.accountId, name, scopes)
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

apiKeysRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const keys = await withClient((client) => listApiKeys(client, req.auth!.accountId));
    res.json({ keys });
  } catch (err) {
    next(err);
  }
});

apiKeysRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const keyId = Number(req.params.id);
    await withClient((client) => revokeApiKey(client, req.auth!.accountId, keyId));
    res.json({ message: "API key revoked." });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});
