import type { Pool, PoolClient } from 'pg';

/**
 * A single, ordered schema migration. `version` is a monotonically increasing
 * integer recorded in `schema_migrations`; `sql` is applied exactly once, in
 * ascending version order, inside the migration transaction.
 */
export interface Migration {
  version: number;
  sql: string;
}

/**
 * The ordered list of embedded DDL migrations for the Postgres announcement
 * store.
 *
 * `paging_token` is stored as BIGINT (Horizon TOIDs are int64) so cursor
 * comparisons are numeric in the database, and `pg` marshals the values back
 * as decimal strings that feed straight into BigInt math. `operations` is the
 * VERBATIM Horizon operation-records array as JSONB — never a projection —
 * because SDK clients consume it unchanged. Idempotent replay rides on the
 * `paging_token` primary key (ON CONFLICT DO NOTHING).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS announcements (
  paging_token BIGINT PRIMARY KEY,
  tx_hash      TEXT NOT NULL,
  memo         TEXT NOT NULL,
  close_time   TIMESTAMPTZ NOT NULL,
  operations   JSONB NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingest_state (
  id              INT PRIMARY KEY CHECK (id = 1),
  cursor          BIGINT,
  start_cursor    BIGINT,
  last_close_time TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

/**
 * 32-bit advisory-lock key for the migration critical section. `hashtext` is a
 * stable Postgres hash of the lock name; a transaction-scoped advisory lock is
 * released automatically at COMMIT/ROLLBACK so a crashed migrator cannot wedge
 * the lock. Concurrent instance boots serialize here; the loser then finds the
 * versions already recorded and applies nothing.
 */
const MIGRATE_LOCK_NAME = 'shade:indexer:migrate';

/**
 * Ensure the `schema_migrations` bookkeeping table exists. Kept outside the
 * numbered set so `migrate` can read applied versions before taking the lock.
 */
async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INT PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** Read the highest applied migration version (0 when none applied). */
async function currentVersion(client: PoolClient): Promise<number> {
  const res = await client.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
  );
  return Number(res.rows[0]?.version ?? 0);
}

/**
 * Apply every pending migration in one transaction that holds
 * `pg_advisory_xact_lock(hashtext('shade:indexer:migrate'))`, so concurrent
 * instance boots cannot race. Each newly applied version is recorded in
 * `schema_migrations`. Idempotent: re-running when up to date is a no-op.
 */
export async function migrate(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transaction-scoped: released on COMMIT/ROLLBACK, even on crash.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      MIGRATE_LOCK_NAME,
    ]);

    const applied = await currentVersion(client);
    for (const migration of MIGRATIONS) {
      if (migration.version <= applied) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        migration.version,
      ]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
