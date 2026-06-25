import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
if (existsSync(resolve(root, ".env"))) {
  dotenv.config({ path: resolve(root, ".env") });
}
