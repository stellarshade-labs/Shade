import type { Pool, PoolClient } from 'pg';

/**
 * Extra grace, in seconds, added to the max relay timebounds window before an
 * OUTSTANDING reservation is considered abandoned. Past `maxTime + grace` the
 * network rejects the inner tx (`tx_too_late`), so a still-OUTSTANDING
 * reservation can only be a crash between `reserve` and `settle`/`refund`.
 */
const RECOVERY_GRACE_SECONDS = 60;

/** Default max relay timebounds window (seconds) when the env var is unset. */
const DEFAULT_MAX_TIMEBOUNDS_SECONDS = 600;

/** How many aged reservations to reclaim per sweep pass. */
const RECOVERY_BATCH = 100;

/** Rows retained per (account, kind) group when pruning `ledger_history`. */
const MAX_HISTORY_ENTRIES = 200;

/**
 * Age (seconds) past which an OUTSTANDING reservation is abandoned:
 * `MAX_RELAY_TIMEBOUNDS_SECONDS` (default 600) + a 60s grace. Read from the
 * environment on each call so config changes take effect without a restart.
 */
export function recoveryThresholdSeconds(): number {
  const raw = Number(process.env.MAX_RELAY_TIMEBOUNDS_SECONDS);
  const base = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TIMEBOUNDS_SECONDS;
  return base + RECOVERY_GRACE_SECONDS;
}

/**
 * Refund a single reservation by id using the SAME atomic conditional UPDATE as
 * {@link PostgresCreditLedger.refund}: the row flips OUTSTANDING -> REFUNDED
 * exactly once (single winner across instances). A debited reservation restores
 * the balance and decrements the net debit counter (pruned at zero) so a
 * genuine retry can re-debit; a no-op reserve just flips state. Returns whether
 * this call was the winner that flipped the row.
 */
async function refundById(client: PoolClient, id: string): Promise<boolean> {
  const res = await client.query<{
    account: string;
    amount_stroops: string;
    ref: string;
    debited: boolean;
  }>(
    `UPDATE reservations SET state = 'REFUNDED', resolved_at = now()
       WHERE id = $1 AND state = 'OUTSTANDING'
       RETURNING account, amount_stroops, ref, debited`,
    [id],
  );
  const rec = res.rows[0];
  if (!rec) return false; // Lost the race / already terminal.
  if (!rec.debited) return true; // Flipped, nothing to restore.

  // Lock the account row before restoring credit so a concurrent mutation on
  // the same account serializes behind us.
  await client.query(
    'INSERT INTO ledger_accounts (account) VALUES ($1) ON CONFLICT DO NOTHING',
    [rec.account],
  );
  await client.query(
    'SELECT balance_stroops FROM ledger_accounts WHERE account = $1 FOR UPDATE',
    [rec.account],
  );
  const amount = BigInt(rec.amount_stroops);
  await client.query(
    `UPDATE ledger_accounts
        SET balance_stroops = balance_stroops + $2,
            history_total   = history_total + 1,
            updated_at      = now()
      WHERE account = $1`,
    [rec.account, amount.toString()],
  );
  await client.query(
    `INSERT INTO ref_counters (account, kind, ref, net) VALUES ($1, 'debit', $2, -1)
       ON CONFLICT (account, kind, ref) DO UPDATE SET net = ref_counters.net - 1`,
    [rec.account, rec.ref],
  );
  await client.query(
    "DELETE FROM ref_counters WHERE account = $1 AND kind = 'debit' AND ref = $2 AND net = 0",
    [rec.account, rec.ref],
  );
  await client.query(
    `INSERT INTO ledger_history (account, kind, amount_stroops, ref)
       VALUES ($1, 'credit', $2, $3)`,
    [rec.account, amount.toString(), `refund:${rec.ref}`],
  );
  return true;
}

/**
 * Refund OUTSTANDING reservations older than {@link recoveryThresholdSeconds}
 * (a crash between reserve and settle/refund). Each reservation is refunded in
 * its own transaction via the atomic conditional UPDATE, so N instances can run
 * this concurrently and every row has exactly one winner — losers no-op.
 * Returns the number of reservations this call actually reclaimed.
 */
export async function recoverStaleReservations(pool: Pool): Promise<number> {
  const thresholdSeconds = recoveryThresholdSeconds();
  const stale = await pool.query<{ id: string }>(
    `SELECT id FROM reservations
       WHERE state = 'OUTSTANDING'
         AND created_at < now() - ($1 * interval '1 second')
       ORDER BY created_at
       LIMIT $2`,
    [thresholdSeconds, RECOVERY_BATCH],
  );

  let reclaimed = 0;
  for (const { id } of stale.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const won = await refundById(client, id);
      await client.query('COMMIT');
      if (won) reclaimed += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return reclaimed;
}

/**
 * Prune `ledger_history` to the newest {@link MAX_HISTORY_ENTRIES} rows per
 * (account, kind) group. The trail is informational only — idempotency comes
 * from `ref_counters` and the surviving `history_total`/`hold_history_total`
 * columns — so trimming old rows never affects a correctness decision. Returns
 * the number of rows deleted.
 */
export async function pruneHistory(pool: Pool): Promise<number> {
  const res = await pool.query(
    `DELETE FROM ledger_history
       WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (
                    PARTITION BY account, kind ORDER BY id DESC
                  ) AS rn
             FROM ledger_history
         ) ranked
         WHERE rn > $1
       )`,
    [MAX_HISTORY_ENTRIES],
  );
  return res.rowCount ?? 0;
}

/** Handle returned by {@link startRecoveryLoop} to stop the periodic sweep. */
export interface RecoveryLoopHandle {
  /** Clear the interval; safe to call more than once. */
  stop(): void;
}

/**
 * Run {@link recoverStaleReservations} + {@link pruneHistory} every
 * `intervalMs` (default 60s). Errors in a pass are swallowed with a warning so
 * a transient DB blip never crashes the process; the next tick retries. The
 * returned handle's `stop()` clears the interval (call it from graceful
 * shutdown).
 */
export function startRecoveryLoop(pool: Pool, intervalMs = 60_000): RecoveryLoopHandle {
  const timer = setInterval(() => {
    void (async () => {
      try {
        await recoverStaleReservations(pool);
        await pruneHistory(pool);
      } catch (err) {
        console.warn('[recovery] sweep failed:', (err as Error).message);
      }
    })();
  }, intervalMs);
  // Do not keep the event loop alive solely for the recovery timer.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
