import { Redis } from "ioredis";
import { config } from "../config.js";

let client: Redis | null = null;
let redisReady = false;

export function isRedisReady(): boolean {
  return redisReady;
}

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl(), {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    client.on("error", (err: Error) => {
      if (redisReady) {
        console.error("[redis] connection error:", err.message);
      }
    });
  }
  return client;
}

export async function connectRedis(): Promise<void> {
  const redis = getRedis();
  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    await redis.ping();
    redisReady = true;
    console.log("[redis] connected");
  } catch (err) {
    redisReady = false;
    if (client) {
      try {
        client.disconnect(false);
      } catch {
        // ignore
      }
      client = null;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (config.redisOptional()) {
      console.warn(`[redis] unavailable (${message}) — continuing with DB fallback only`);
      return;
    }
    throw new Error(`Redis connection failed: ${message}`);
  }
}

export async function closeRedis(): Promise<void> {
  redisReady = false;
  if (client) {
    try {
      await client.quit();
    } catch {
      client.disconnect(false);
    }
    client = null;
  }
}

export function roleCacheKey(userId: number): string {
  return `giftcred:role:${userId}`;
}

export function otpRateLimitKey(email: string): string {
  return `giftcred:otp:rate:${email.toLowerCase()}`;
}

export const SESSION_ACTIVITY_TTL_SECONDS = 1800;

export function sessionActivityKey(sessionId: number): string {
  return `session_activity:${sessionId}`;
}
