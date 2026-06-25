import cors from "cors";
import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import passport from "passport";
import { pinoHttp } from "pino-http";
import { apiKeysRouter } from "./api-keys/routes.js";
import { accountsRouter } from "./accounts/routes.js";
import { logger } from "./logger.js";
import { apiKeyMiddleware } from "./middleware/apiKeyMiddleware.js";
import { auditRouter } from "./audit/routes.js";
import { configurePassport } from "./auth/sso.service.js";
import { authRouter } from "./auth/routes.js";
import { catalogRouter } from "./catalog/routes.js";
import { config } from "./config.js";
import { getPool } from "./db.js";
import { ordersRouter, purchaseRouter } from "./orders/routes.js";
import { usersRouter } from "./users/routes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(
    cors({
      origin: config.corsOrigins(),
      credentials: true,
    })
  );

  configurePassport();
  app.use(passport.initialize());

  app.get("/", (_req, res) => {
    res.json({
      service: "GiftCred Auth API",
      status: "running",
      health: "/health",
      endpoints: {
        auth: {
          login: "POST /api/auth/login",
          otpRequest: "POST /api/auth/otp/request",
          otpVerify: "POST /api/auth/otp/verify",
          refresh: "POST /api/auth/refresh",
          logout: "POST /api/auth/logout",
          me: "GET /api/auth/me",
          mfaSetup: "POST /api/auth/mfa/setup",
          mfaEnable: "POST /api/auth/mfa/enable",
          mfaVerify: "POST /api/auth/mfa/verify",
          sessions: "GET /api/auth/sessions",
          revokeSession: "DELETE /api/auth/sessions/:id",
          googleSso: "GET /api/auth/sso/google",
          microsoftSso: "GET /api/auth/sso/microsoft",
        },
        users: {
          list: "GET /api/users",
          roles: "GET /api/users/roles",
          invite: "POST /api/users/invites",
          acceptInvite: "POST /api/users/invites/accept",
        },
        accounts: {
          list: "GET /api/accounts",
          createMaster: "POST /api/accounts/master",
          createChild: "POST /api/accounts/child",
        },
        audit: {
          logs: "GET /api/audit/logs",
        },
        catalog: {
          list: "GET /api/catalog",
          product: "GET /api/catalog/:sku",
        },
        orders: {
          list: "GET /api/orders",
          purchase: "POST /api/purchase",
        },
      },
    });
  });

  app.get("/health", async (_req, res) => {
    try {
      await getPool().query("SELECT 1");
      res.json({ status: "ok", service: "giftcred-auth-api" });
    } catch (err) {
      res.status(503).json({
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.use(apiKeyMiddleware);

  app.use("/api/auth", authRouter);
  app.use("/api/accounts", accountsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/keys", apiKeysRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/purchase", purchaseRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "Unhandled error");
    const message = config.isProd()
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal server error";
    res.status(500).json({ error: message });
  });

  return app;
}
