import { Pool } from 'pg';
import type { AnnouncementStore } from './types.js';
import { MemoryAnnouncementStore } from './memory.js';
import { PostgresAnnouncementStore } from './postgres.js';
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

/** The announcement store plus which backend it is (surfaced in /health). */
export interface AnnouncementStoreHandle {
  store: AnnouncementStore;
  kind: 'postgres' | 'memory';
}

/**
 * Build the announcement store from the environment.
 *
 * `DATABASE_URL` set → Postgres (durable + multi-instance): ping + migrate via
 * `init()`. If the database is set but unreachable or migration fails this
 * THROWS — the caller exits 1. NEVER a silent fallback to memory: a configured
 * deploy that quietly forgets its cursor would re-serve or re-scan the feed.
 *
 * `DATABASE_URL` unset → in-process memory store (dev fallback) with one loud
 * warning: announcements are lost on restart and the ingester re-ingests from
 * INGEST_START.
 */
export async function createAnnouncementStore(): Promise<AnnouncementStoreHandle> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const pool = new Pool({
      connectionString: url,
      max: pgPoolMax(),
      ssl: sslFor(url),
    });
    const store = new PostgresAnnouncementStore(pool);
    try {
      await store.init();
    } catch (err) {
      await pool.end().catch(() => {});
      throw new Error(
        'DATABASE_URL is set but the Postgres announcement store could not be ' +
          `initialised (unreachable or migration failed): ${(err as Error).message}`,
      );
    }
    logger.info('Announcement store backend: Postgres', { poolMax: pgPoolMax() });
    return { store, kind: 'postgres' };
  }
  logger.warn('Announcement store backend: in-process memory', {
    message:
      'DATABASE_URL is unset: announcements are LOST on restart and the ' +
      'ingester re-ingests from INGEST_START. Set DATABASE_URL for a durable ' +
      'index.',
  });
  const store = new MemoryAnnouncementStore();
  await store.init();
  return { store, kind: 'memory' };
}
