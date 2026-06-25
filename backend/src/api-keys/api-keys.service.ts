import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import type { PoolClient } from "pg";
import { AuthError } from "../lib/errors.js";
import type { AuthContext } from "../types/auth.js";
import { parseIpAllowlist } from "../lib/ipUtils.js";

const KEY_BYTES = 32;
const PREFIX_LENGTH = 8;

export interface ApiKeyRow {
  id: number;
  account_id: number;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function generateApiKeyMaterial(): { plaintext: string; prefix: string } {
  const plaintext = randomBytes(KEY_BYTES).toString("base64url");
  const prefix = plaintext.slice(0, PREFIX_LENGTH);
  return { plaintext, prefix };
}

export async function createApiKey(
  client: PoolClient,
  accountId: number,
  name: string,
  scopes: string[],
  expiresAt?: Date | null
): Promise<{ id: number; key: string; prefix: string; name: string; scopes: string[] }> {
  if (!name.trim()) {
    throw new AuthError("API key name is required.", 400);
  }

  const { plaintext, prefix } = generateApiKeyMaterial();
  const keyHash = await bcrypt.hash(plaintext, 12);

  const result = await client.query<{ id: number }>(
    `
    INSERT INTO api_keys (account_id, name, key_hash, prefix, scopes, expires_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    RETURNING id
    `,
    [accountId, name.trim(), keyHash, prefix, JSON.stringify(scopes), expiresAt ?? null]
  );

  return {
    id: result.rows[0].id,
    key: plaintext,
    prefix,
    name: name.trim(),
    scopes,
  };
}

export async function listApiKeys(client: PoolClient, accountId: number) {
  const result = await client.query<ApiKeyRow>(
    `
    SELECT id, account_id, name, prefix, scopes, created_at, expires_at, revoked_at
    FROM api_keys
    WHERE account_id = $1 AND revoked_at IS NULL
    ORDER BY created_at DESC
    `,
    [accountId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: `${row.prefix}…`,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

export async function revokeApiKey(
  client: PoolClient,
  accountId: number,
  keyId: number
): Promise<void> {
  const result = await client.query(
    `
    UPDATE api_keys
    SET revoked_at = NOW()
    WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
    RETURNING id
    `,
    [keyId, accountId]
  );
  if (!result.rows.length) {
    throw new AuthError("API key not found.", 404);
  }
}

export async function verifyApiKey(
  client: PoolClient,
  rawKey: string
): Promise<{
  accountId: number;
  keyId: number;
  scopes: string[];
  accountType: AuthContext["accountType"];
  ipAllowlist: string[];
} | null> {
  if (!rawKey || rawKey.length < PREFIX_LENGTH) return null;

  const prefix = rawKey.slice(0, PREFIX_LENGTH);
  const result = await client.query<{
    id: number;
    account_id: number;
    key_hash: string;
    scopes: string[];
    expires_at: Date | null;
    account_type: AuthContext["accountType"];
    ip_allowlist: unknown;
  }>(
    `
    SELECT k.id, k.account_id, k.key_hash, k.scopes, k.expires_at, a.account_type,
           COALESCE(a.ip_allowlist, '[]'::jsonb) AS ip_allowlist
    FROM api_keys k
    JOIN accounts a ON a.id = k.account_id
    WHERE k.prefix = $1 AND k.revoked_at IS NULL
    `,
    [prefix]
  );

  for (const row of result.rows) {
    if (row.expires_at && new Date(row.expires_at) < new Date()) continue;
    const valid = await bcrypt.compare(rawKey, row.key_hash);
    if (!valid) continue;
    return {
      accountId: row.account_id,
      keyId: row.id,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      accountType: row.account_type,
      ipAllowlist: parseIpAllowlist(row.ip_allowlist),
    };
  }

  return null;
}

/** System-level B2B user identifier for API key authentication. */
export const B2B_SYSTEM_USER_ID = 0;
