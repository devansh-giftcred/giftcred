/**
 * Creates the first platform owner user (run once after migrate).
 *
 * Usage:
 *   npm run seed:admin
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=secret npm run seed:admin
 */
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const root = process.cwd();
if (existsSync(resolve(root, ".env"))) dotenv.config({ path: resolve(root, ".env") });

const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@giftcred.com").trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD ?? "Giftcred@123";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const client = await pool.connect();
try {
  const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing.rows.length) {
    console.log(`User already exists: ${email} (id=${existing.rows[0].id})`);
    process.exit(0);
  }

  const platform = await client.query(
    `SELECT id FROM accounts WHERE account_type = 'platform' LIMIT 1`
  );
  const accountId = platform.rows[0]?.id;
  if (!accountId) throw new Error("Platform account missing — run npm run migrate first");

  const role = await client.query(
    `SELECT id FROM roles WHERE account_id = $1 AND slug = 'platform_owner' LIMIT 1`,
    [accountId]
  );
  const roleId = role.rows[0]?.id;
  if (!roleId) throw new Error("platform_owner role missing — run npm run migrate first");

  const passwordHash = await bcrypt.hash(password, 12);
  const inserted = await client.query(
    `
    INSERT INTO users (
      account_id, role_id, email, password_hash,
      first_name, last_name, status, email_verified_at
    ) VALUES ($1, $2, $3, $4, 'Platform', 'Owner', 'active', NOW())
    RETURNING id
    `,
    [accountId, roleId, email, passwordHash]
  );

  console.log("Platform owner created:");
  console.log("  id:", inserted.rows[0].id);
  console.log("  email:", email);
  console.log("  password:", password);
  console.log("  login: POST http://localhost:3001/api/auth/login");
} finally {
  client.release();
  await pool.end();
}
