import pg from "pg";
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
if (existsSync(resolve(root, ".env"))) dotenv.config({ path: resolve(root, ".env") });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  const users = await client.query("SELECT COUNT(*)::int AS n FROM users");
  const accounts = await client.query("SELECT COUNT(*)::int AS n FROM accounts");
  const roles = await client.query("SELECT COUNT(*)::int AS n FROM roles");
  console.log("DB connected:", process.env.DATABASE_URL?.replace(/:[^:@/]+@/, ":****@"));
  console.log("users:", users.rows[0].n);
  console.log("accounts:", accounts.rows[0].n);
  console.log("roles:", roles.rows[0].n);
} finally {
  client.release();
  await pool.end();
}
