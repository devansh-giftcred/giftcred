import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.isProd() ? "info" : "debug",
  transport: config.isProd()
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
});
