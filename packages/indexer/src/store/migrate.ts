import { Pool } from 'pg';
import { migrate } from './migrations.js';

/**
 * Standalone migration runner (`npm run migrate`). Applies pending schema
 * migrations against `DATABASE_URL` and exits. Boot also auto-migrates via
 * `PostgresAnnouncementStore.init()`, so this is for operators who prefer an
 * explicit deploy step; running both is safe (migration is idempotent and
 * guarded by a Postgres advisory lock).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set — nothing to migrate.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: url,
    ssl: /sslmode=(require|verify-ca|verify-full|prefer)/.test(url) ||
      process.env.PGSSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
  });
  try {
    await migrate(pool);
    console.log('[migrate] Schema is up to date.');
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[migrate] Failed:', err.message);
  process.exit(1);
});
