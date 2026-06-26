import { Router } from "express";
import { withClient, withTransaction } from "../db.js";
import { ConcurrencyError, LedgerError } from "../lib/errors.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { captureHold, placeHold, voidHold } from "./holds.service.js";
import { getWalletsForUser } from "./ledger.service.js";
import type { AuthedRequest } from "../types/auth.js";

export const ledgerRouter = Router();

ledgerRouter.use(authMiddleware);

ledgerRouter.get("/wallets/me", async (req: AuthedRequest, res, next) => {
  try {
    if (!req.auth || req.auth.isApiKeyAuth) {
      res.status(403).json({ error: "User wallet access required." });
      return;
    }

    const wallets = await withClient((client) =>
      getWalletsForUser(client, req.auth!.userId, req.auth!.accountId)
    );

    res.json({
      wallets: wallets.map((w) => ({
        id: w.id,
        currencyCode: w.currency_code,
        ledgerBalance: w.ledger_balance,
        heldBalance: w.held_balance,
        availableBalance: w.available_balance,
        status: w.status,
      })),
    });
  } catch (err) {
    next(err);
  }
});

ledgerRouter.post("/holds", async (req: AuthedRequest, res, next) => {
  try {
    if (!req.auth || req.auth.isApiKeyAuth) {
      res.status(403).json({ error: "User authentication required." });
      return;
    }

    const accountId = String(req.body?.accountId ?? "");
    const amount = Number(req.body?.amount);
    const ttlMinutes = Number(req.body?.ttlMinutes ?? 30);
    const idempotencyKey = String(req.body?.idempotencyKey ?? "");
    const orderReference = String(req.body?.orderReference ?? "");

    if (!accountId || !Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "accountId and positive amount are required." });
      return;
    }
    if (!idempotencyKey || !orderReference) {
      res.status(400).json({ error: "idempotencyKey and orderReference are required." });
      return;
    }

    const hold = await withTransaction((client) =>
      placeHold(client, accountId, amount, ttlMinutes, idempotencyKey, orderReference)
    );

    res.status(201).json({
      hold: {
        id: hold.id,
        accountId: hold.account_id,
        amount: hold.amount,
        status: hold.status,
        orderReference: hold.order_reference,
        ttlExpiresAt: hold.ttl_expires_at,
      },
    });
  } catch (err) {
    if (err instanceof LedgerError || err instanceof ConcurrencyError) {
      res.status(err instanceof ConcurrencyError ? 409 : err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

ledgerRouter.post("/holds/:id/capture", async (req: AuthedRequest, res, next) => {
  try {
    const holdId = String(req.params.id);
    const captureAmount = Number(req.body?.captureAmount);
    const destinationAccountId = String(req.body?.destinationAccountId ?? "");
    const idempotencyKey = String(req.body?.idempotencyKey ?? `capture-${holdId}`);

    if (!holdId || !Number.isFinite(captureAmount) || captureAmount <= 0) {
      res.status(400).json({ error: "hold id and positive captureAmount are required." });
      return;
    }
    if (!destinationAccountId) {
      res.status(400).json({ error: "destinationAccountId is required." });
      return;
    }

    const result = await withTransaction((client) =>
      captureHold(client, holdId, captureAmount, destinationAccountId, idempotencyKey)
    );

    res.json({
      hold: {
        id: result.hold.id,
        status: result.hold.status,
        journalEntryId: result.journalEntryId,
      },
    });
  } catch (err) {
    if (err instanceof LedgerError || err instanceof ConcurrencyError) {
      res.status(err instanceof ConcurrencyError ? 409 : err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

ledgerRouter.post("/holds/:id/void", async (req: AuthedRequest, res, next) => {
  try {
    const holdId = String(req.params.id);
    if (!holdId) {
      res.status(400).json({ error: "hold id is required." });
      return;
    }

    const hold = await withTransaction((client) => voidHold(client, holdId));

    res.json({
      hold: {
        id: hold.id,
        status: hold.status,
      },
    });
  } catch (err) {
    if (err instanceof LedgerError || err instanceof ConcurrencyError) {
      res.status(err instanceof ConcurrencyError ? 409 : err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});
