import { createApp } from "./src/app.js";
import { config } from "./src/config.js";
import { closePool } from "./src/db.js";
import { closeRedis, connectRedis } from "./src/redis/client.js";

async function main() {
  await connectRedis();
  const app = createApp();
  const port = config.port();

  const server = app.listen(port, () => {
    console.log(`GiftCred Auth API listening on http://localhost:${port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    server.close();
    await closePool();
    await closeRedis();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
