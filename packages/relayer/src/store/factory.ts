import { Pool } from 'pg';
import { Redis } from 'ioredis';
import type { CreditLedger } from '../ledger.js';
import { JsonCreditLedger } from '../ledger.js';
import { PostgresCreditLedger } from './postgres.js';
import { startRecoveryLoop, type RecoveryLoopHandle } from './recovery.js';
import type { ChallengeStore } from '../utils/auth.js';
import { MemoryChallengeStore } from '../utils/auth.js';
import type { RateLimitStore } from '../utils/rateLimit.js';
import { MemoryRateLimitStore } from '../utils/rateLimit.js';
import { RedisChallengeStore } from '../utils/authRedis.js';
import { RedisRateLimitStore } from '../utils/rateLimitRedis.js';
import { logger } from '../utils/logger.js';

/** Max Postgres pool connections (free-tier providers cap low; keep small). */
function pgPoolMax(): number {
  const n = Number(process.env.PGPOOL_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/**
 * TLS config for the pool. Managed Postgres (Neon/Supabase) requires TLS and
 * advertises it via `sslmode=require` in the URL; `rejectUnauthorized:false`
 * tolerates provider chains not in the default CA bundle (the connection is
 * still encrypted). Plain local Postgres (docker) uses no TLS.
 */
function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
  return /sslmode=(require|verify-ca|verify-full|prefer)/.test(url) ||
    process.env.PGSSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined;
}

/** The credit ledger plus its lifecycle (recovery loop, pool) for shutdown. */
export interface LedgerHandle {
  ledger: CreditLedger;
  kind: 'postgres' | 'json';
  close(): Promise<void>;
}

/**
 * Build the credit ledger from the environment.
 *
 * `DATABASE_URL` set → Postgres (durable + multi-instance): ping, migrate, an
 * initial reservation-recovery sweep, then a periodic recovery loop. If the
 * database is set but unreachable or migration fails this THROWS — the caller
 * exits 1. We never silently fall back to the JSON file, because a configured
 * deploy that quietly forks its money ledger onto ephemeral local disk is worse
 * than not starting.
 *
 * `DATABASE_URL` unset → the JSON-file ledger (dev fallback); the ephemeral-FS
 * warning still fires from boot.ts when credit gating is on.
 */
export async function createCreditLedger(): Promise<LedgerHandle> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const pool = new Pool({
      connectionString: url,
      max: pgPoolMax(),
      ssl: sslFor(url),
    });
    const ledger = new PostgresCreditLedger(pool);
    try {
      await ledger.init();
    } catch (err) {
      await pool.end().catch(() => {});
      throw new Error(
        'DATABASE_URL is set but the Postgres ledger could not be initialised ' +
          `(unreachable or migration failed): ${(err as Error).message}`,
      );
    }
    const recovery: RecoveryLoopHandle = startRecoveryLoop(pool);
    logger.info('Credit ledger backend: Postgres', { poolMax: pgPoolMax() });
    return {
      ledger,
      kind: 'postgres',
      async close() {
        recovery.stop();
        await pool.end().catch(() => {});
      },
    };
  }
  logger.info('Credit ledger backend: JSON file (dev fallback)');
  return { ledger: new JsonCreditLedger(), kind: 'json', async close() {} };
}

/** Shared challenge + rate-limit state plus its lifecycle for shutdown. */
export interface SharedStateHandle {
  challenges: ChallengeStore;
  rateLimitStore: RateLimitStore;
  kind: 'redis' | 'memory';
  close(): Promise<void>;
}

/**
 * Build the shared challenge-nonce + rate-limit stores from the environment.
 *
 * `REDIS_URL` set → one shared ioredis client backs both, so challenge nonces
 * and rate-limit buckets are consistent across every instance (a nonce is
 * single-use fleet-wide; one client shares one bucket). Boot pings Redis and
 * THROWS on failure (caller exits 1) — auth/rate-limit are fail-closed, so a
 * configured-but-unreachable Redis must not degrade to per-instance memory.
 *
 * `REDIS_URL` unset → in-process memory stores (single-instance dev/BYO).
 */
export async function createSharedState(): Promise<SharedStateHandle> {
  const url = process.env.REDIS_URL?.trim();
  if (url) {
    const redis = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
    });
    try {
      await redis.ping();
    } catch (err) {
      redis.disconnect();
      throw new Error(
        'REDIS_URL is set but Redis is unreachable: ' + (err as Error).message,
      );
    }
    logger.info('Shared state backend: Redis');
    return {
      challenges: new RedisChallengeStore(redis),
      rateLimitStore: new RedisRateLimitStore(redis),
      kind: 'redis',
      async close() {
        await redis.quit().catch(() => {});
      },
    };
  }
  logger.info('Shared state backend: in-process memory (single instance)');
  return {
    challenges: new MemoryChallengeStore(),
    rateLimitStore: new MemoryRateLimitStore(),
    kind: 'memory',
    async close() {},
  };
}
