import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";

let pool: Pool | null = null;

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

export function getPool(): Pool {
  if (!pool) {
    const connectionString = config.databaseUrl();
    pool = new Pool({
      connectionString,
      ssl: resolveSsl(connectionString),
      keepAlive: true,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
  }
  return pool;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  return withClient(async (client) => client.query<T>(text, params));
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
