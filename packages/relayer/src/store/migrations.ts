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
 * The ordered list of embedded DDL migrations for the Postgres credit ledger.
 *
 * Stroops are stored as BIGINT (max XLM supply is well under 2^63-1) so the
 * driver marshals them as strings that feed straight into BigInt math — the
 * ledger never touches a float. Every money invariant is a database-enforced
 * backstop: no double-claim (`consumed_txs` PK), no negative balance/held
 * (CHECKs), single-winner settle/refund (conditional UPDATEs on state), and
 * O(1) idempotency via `ref_counters`. History is an informational trail,
 * capped by the recovery job, never read for a correctness decision.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS ledger_accounts (
  account                TEXT PRIMARY KEY,
  balance_stroops        BIGINT NOT NULL DEFAULT 0 CHECK (balance_stroops >= 0),
  sponsored_held_stroops BIGINT NOT NULL DEFAULT 0 CHECK (sponsored_held_stroops >= 0),
  history_total          BIGINT NOT NULL DEFAULT 0,
  hold_history_total     BIGINT NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumed_txs (
  tx_hash    TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id             UUID PRIMARY KEY,
  account        TEXT NOT NULL,
  amount_stroops BIGINT NOT NULL CHECK (amount_stroops >= 0),
  ref            TEXT NOT NULL,
  debited        BOOLEAN NOT NULL,
  state          TEXT NOT NULL DEFAULT 'OUTSTANDING'
                 CHECK (state IN ('OUTSTANDING','SETTLED','REFUNDED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS reservations_outstanding_idx
  ON reservations (created_at) WHERE state = 'OUTSTANDING';

CREATE TABLE IF NOT EXISTS ref_counters (
  account TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('debit','hold')),
  ref     TEXT NOT NULL,
  net     INT  NOT NULL,
  PRIMARY KEY (account, kind, ref)
);

CREATE TABLE IF NOT EXISTS ledger_history (
  id             BIGSERIAL PRIMARY KEY,
  account        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('credit','debit','hold','release')),
  amount_stroops BIGINT NOT NULL,
  ref            TEXT NOT NULL,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_history_account_idx
  ON ledger_history (account, id DESC);
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
const MIGRATE_LOCK_NAME = 'shade:migrate';

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
 * `pg_advisory_xact_lock(hashtext('shade:migrate'))`, so concurrent instance
 * boots cannot race. Each newly applied version is recorded in
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
