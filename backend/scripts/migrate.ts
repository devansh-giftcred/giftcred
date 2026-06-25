import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../src/config.js";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, "../migrations");

function resolveSsl(connectionString: string): boolean | { rejectUnauthorized: boolean } | undefined {
  const lower = connectionString.toLowerCase();
  if (lower.includes("localhost") || lower.includes("127.0.0.1")) return undefined;
  if (lower.includes("sslmode=disable") || lower.includes("ssl=false")) return undefined;
  if (
    process.env.DATABASE_SSL === "true" ||
    lower.includes("sslmode=require") ||
    lower.includes("neon.tech") ||
    lower.includes("supabase.co")
  ) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function parseDatabaseName(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name) throw new Error("DATABASE_URL must include a database name");
  return name;
}

function adminDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const dbName = parseDatabaseName(databaseUrl);
  const adminPool = new Pool({
    connectionString: adminDatabaseUrl(databaseUrl),
    ssl: resolveSsl(databaseUrl),
  });

  try {
    const exists = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!exists.rows.length) {
      await adminPool.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
      console.log(`Created database: ${dbName}`);
    }
  } finally {
    await adminPool.end();
  }
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function backfillExistingMigrations(client: pg.PoolClient): Promise<void> {
  const count = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM schema_migrations`
  );
  if (Number(count.rows[0]?.count ?? 0) > 0) return;

  const usersTable = await client.query<{ reg: string | null }>(
    `SELECT to_regclass('public.users')::text AS reg`
  );
  if (usersTable.rows[0]?.reg) {
    await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [
      "001_auth_rbac_schema.sql",
    ]);
    console.log("Backfilled migration record: 001_auth_rbac_schema.sql");
  }
}

async function migrate() {
  const databaseUrl = config.databaseUrl();
  console.log("Connecting to:", databaseUrl.replace(/:[^:@/]+@/, ":****@"));

  await ensureDatabaseExists(databaseUrl);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: resolveSsl(databaseUrl),
  });

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    await backfillExistingMigrations(client);

    for (const file of files) {
      const applied = await client.query(
        `SELECT 1 FROM schema_migrations WHERE filename = $1`,
        [file]
      );
      if (applied.rows.length) {
        console.log("Skipped (already applied):", file);
        continue;
      }

      const migrationPath = resolve(migrationsDir, file);
      const sql = readFileSync(migrationPath, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        console.log("Migration applied:", file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
