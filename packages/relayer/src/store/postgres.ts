import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CreditLedger,
  HoldHistoryEntry,
  LedgerAccount,
  LedgerHistoryEntry,
  Reservation,
} from '../ledger.js';
import { fromStroops, toStroops } from '../ledger.js';
import { migrate } from './migrations.js';
import { recoverStaleReservations } from './recovery.js';

/**
 * Max entries returned in each per-account history trail. Mirrors the JSON
 * backend's cap so the {@link LedgerAccount} shape is identical across backends.
 * The trail is informational only (idempotency comes from `ref_counters`), so
 * bounding it here — and pruning the underlying rows in the recovery job — is
 * safe.
 */
const MAX_HISTORY_ENTRIES = 200;

/** Shape of the `ledger_accounts` row we lock and read. */
interface AccountRow {
  balance_stroops: string;
  sponsored_held_stroops: string;
}

/**
 * A durable, multi-instance {@link CreditLedger} backed by Postgres.
 *
 * Every mutation runs in one short READ COMMITTED transaction. Per-account
 * serialization — the cross-instance replacement for the JSON backend's
 * in-process promise locks — is a `SELECT ... FOR UPDATE` on the account's row
 * ({@link lockAccount}). All arithmetic is BigInt stroops (BIGINT columns are
 * marshaled as strings by `pg` and fed straight into `BigInt()`), so no float
 * ever touches the money path. The exact error strings the routes depend on
 * (`tx_already_claimed`, `insufficient_credit`, `sponsored_held_exceeded`) are
 * preserved.
 */
export class PostgresCreditLedger implements CreditLedger {
  constructor(private readonly pool: Pool) {}

  /**
   * Ping the database, apply pending migrations, and run one initial recovery
   * sweep (refunds OUTSTANDING reservations left by a crash). Call once at boot
   * before serving traffic; a failure should be fatal (never fall back to a
   * different store).
   */
  async init(): Promise<void> {
    await this.pool.query('SELECT 1');
    await migrate(this.pool);
    await recoverStaleReservations(this.pool);
  }

  /**
   * Run `fn` inside a READ COMMITTED transaction on a dedicated connection,
   * committing on success and rolling back on any throw. The thrown error is
   * re-raised unchanged so exact error strings propagate to the routes.
   */
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Take the per-account row lock, creating the row on first touch. Returns the
   * locked balances. This is the concurrency primitive: two callers on the same
   * account serialize here; callers on different accounts do not block.
   */
  private async lockAccount(client: PoolClient, account: string): Promise<AccountRow> {
    await client.query(
      'INSERT INTO ledger_accounts (account) VALUES ($1) ON CONFLICT DO NOTHING',
      [account],
    );
    const res = await client.query<AccountRow>(
      `SELECT balance_stroops, sponsored_held_stroops
         FROM ledger_accounts WHERE account = $1 FOR UPDATE`,
      [account],
    );
    // The INSERT ... ON CONFLICT guarantees the row exists before the SELECT.
    return res.rows[0]!;
  }

  /**
   * Read the net (debits - refunds, or holds - releases) counter for a ref
   * under the already-held row lock. Absent row => 0.
   */
  private async refNet(
    client: PoolClient,
    account: string,
    kind: 'debit' | 'hold',
    ref: string,
  ): Promise<number> {
    const res = await client.query<{ net: string }>(
      'SELECT net FROM ref_counters WHERE account = $1 AND kind = $2 AND ref = $3',
      [account, kind, ref],
    );
    return res.rows[0] ? Number(res.rows[0].net) : 0;
  }

  /**
   * Adjust a per-ref counter by `delta`, pruning it to zero (DELETE) so the
   * table cannot accumulate settled refs. Mirrors the JSON backend's
   * `bumpCounter`: a ref whose net returns to zero is removed, which re-enables
   * a genuine retry (same signed tx => same ref) to re-apply.
   */
  private async bumpCounter(
    client: PoolClient,
    account: string,
    kind: 'debit' | 'hold',
    ref: string,
    delta: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ref_counters (account, kind, ref, net) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account, kind, ref)
         DO UPDATE SET net = ref_counters.net + $4`,
      [account, kind, ref, delta],
    );
    await client.query(
      'DELETE FROM ref_counters WHERE account = $1 AND kind = $2 AND ref = $3 AND net = 0',
      [account, kind, ref],
    );
  }

  /** Append one informational history row (credit/debit/hold/release). */
  private async pushHistory(
    client: PoolClient,
    account: string,
    kind: 'credit' | 'debit' | 'hold' | 'release',
    amountStroops: bigint,
    ref: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ledger_history (account, kind, amount_stroops, ref)
         VALUES ($1, $2, $3, $4)`,
      [account, kind, amountStroops.toString(), ref],
    );
  }

  async hasConsumed(txHash: string): Promise<boolean> {
    const res = await this.pool.query('SELECT 1 FROM consumed_txs WHERE tx_hash = $1', [
      txHash,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async getBalance(account: string): Promise<string | null> {
    const res = await this.pool.query<{ balance_stroops: string }>(
      'SELECT balance_stroops FROM ledger_accounts WHERE account = $1',
      [account],
    );
    const row = res.rows[0];
    return row ? fromStroops(BigInt(row.balance_stroops)) : null;
  }

  /**
   * Rebuild the full {@link LedgerAccount} record so the returned shape matches
   * the JSON backend exactly: chronological (oldest-first) bounded history and
   * hold-history trails, plus the surviving `historyTotal`/`holdHistoryTotal`
   * counters. Returns null for an unknown account.
   */
  async getAccount(account: string): Promise<LedgerAccount | null> {
    const acctRes = await this.pool.query<{
      balance_stroops: string;
      sponsored_held_stroops: string;
      history_total: string;
      hold_history_total: string;
      updated_at: Date;
    }>(
      `SELECT balance_stroops, sponsored_held_stroops, history_total,
              hold_history_total, updated_at
         FROM ledger_accounts WHERE account = $1`,
      [account],
    );
    const row = acctRes.rows[0];
    if (!row) return null;

    // Most-recent 200 rows, then reversed to chronological to match the JSON
    // backend's push+rotate ordering.
    const historyRes = await this.pool.query<{
      kind: string;
      amount_stroops: string;
      ref: string;
      at: Date;
    }>(
      `SELECT kind, amount_stroops, ref, at
         FROM ledger_history
        WHERE account = $1 AND kind IN ('credit','debit')
        ORDER BY id DESC LIMIT $2`,
      [account, MAX_HISTORY_ENTRIES],
    );
    const holdRes = await this.pool.query<{
      kind: string;
      amount_stroops: string;
      ref: string;
      at: Date;
    }>(
      `SELECT kind, amount_stroops, ref, at
         FROM ledger_history
        WHERE account = $1 AND kind IN ('hold','release')
        ORDER BY id DESC LIMIT $2`,
      [account, MAX_HISTORY_ENTRIES],
    );

    const history: LedgerHistoryEntry[] = historyRes.rows
      .map((h) => ({
        type: h.kind as 'credit' | 'debit',
        amount: fromStroops(BigInt(h.amount_stroops)),
        ref: h.ref,
        at: h.at.toISOString(),
      }))
      .reverse();
    const holdHistory: HoldHistoryEntry[] = holdRes.rows
      .map((h) => ({
        type: h.kind as 'hold' | 'release',
        amount: fromStroops(BigInt(h.amount_stroops)),
        ref: h.ref,
        at: h.at.toISOString(),
      }))
      .reverse();

    return {
      balance: fromStroops(BigInt(row.balance_stroops)),
      sponsoredHeld: fromStroops(BigInt(row.sponsored_held_stroops)),
      updatedAt: row.updated_at.toISOString(),
      history,
      holdHistory,
      historyTotal: Number(row.history_total),
      holdHistoryTotal: Number(row.hold_history_total),
    };
  }

  async hasSufficient(account: string, amount: string): Promise<boolean> {
    const res = await this.pool.query<{ balance_stroops: string }>(
      'SELECT balance_stroops FROM ledger_accounts WHERE account = $1',
      [account],
    );
    const row = res.rows[0];
    if (!row) return false;
    return BigInt(row.balance_stroops) >= toStroops(amount);
  }

  /**
   * Credit an account from a verified deposit tx. Idempotency is the
   * `consumed_txs` PK: the INSERT ... ON CONFLICT DO NOTHING inserts nothing on
   * a replay (rowCount 0) and we throw `tx_already_claimed` — a racing loser
   * blocks on the PK until the winner commits, then also throws (the exact
   * loser-throws behaviour `routes/credit.ts` depends on).
   */
  async credit(account: string, amount: string, txHash: string): Promise<LedgerAccount> {
    const delta = toStroops(amount);
    await this.tx(async (client) => {
      const ins = await client.query(
        'INSERT INTO consumed_txs (tx_hash, account) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [txHash, account],
      );
      if ((ins.rowCount ?? 0) === 0) {
        throw new Error('tx_already_claimed');
      }
      await this.lockAccount(client, account);
      await client.query(
        `UPDATE ledger_accounts
            SET balance_stroops = balance_stroops + $2,
                history_total   = history_total + 1,
                updated_at      = now()
          WHERE account = $1`,
        [account, delta.toString()],
      );
      await this.pushHistory(client, account, 'credit', delta, txHash);
    });
    return (await this.getAccount(account))!;
  }

  /**
   * Debit an account by an amount. Idempotent by `ref`: a positive net debit
   * counter means an outstanding un-refunded debit, so this is a no-op. Throws
   * `insufficient_credit` when the balance would go negative. A refunded ref
   * (net back to zero) re-debits on a genuine retry.
   */
  async debit(account: string, amount: string, ref: string): Promise<LedgerAccount> {
    await this.tx(async (client) => {
      await this.debitInternal(client, account, amount, ref);
    });
    return (await this.getAccount(account))!;
  }

  /**
   * Shared debit body (also the inner step of {@link reserve}). Assumes it runs
   * inside {@link tx}. Locks the account, applies the O(1) idempotency check,
   * and either no-ops (returns `debited:false`) or moves credit and bumps the
   * counter (`debited:true`). Throws `insufficient_credit` on an overdraw.
   */
  private async debitInternal(
    client: PoolClient,
    account: string,
    amount: string,
    ref: string,
  ): Promise<boolean> {
    const row = await this.lockAccount(client, account);
    const net = await this.refNet(client, account, 'debit', ref);
    if (net > 0) {
      return false;
    }
    const remaining = BigInt(row.balance_stroops) - toStroops(amount);
    if (remaining < 0n) {
      throw new Error('insufficient_credit');
    }
    await client.query(
      `UPDATE ledger_accounts
          SET balance_stroops = $2, history_total = history_total + 1, updated_at = now()
        WHERE account = $1`,
      [account, remaining.toString()],
    );
    await this.bumpCounter(client, account, 'debit', ref, 1);
    await this.pushHistory(client, account, 'debit', toStroops(amount), ref);
    return true;
  }

  /**
   * Atomically check credit and debit the fee BEFORE the caller submits, then
   * record an OUTSTANDING reservation in the same transaction. The row lock
   * serializes two concurrent reserves against a one-fee balance so exactly one
   * debits. Idempotent by `ref`. Throws `insufficient_credit` on an overdraw.
   */
  async reserve(account: string, amount: string, ref: string): Promise<Reservation> {
    const id = randomUUID();
    const debited = await this.tx(async (client) => {
      const didDebit = await this.debitInternal(client, account, amount, ref);
      await client.query(
        `INSERT INTO reservations (id, account, amount_stroops, ref, debited, state)
           VALUES ($1, $2, $3, $4, $5, 'OUTSTANDING')`,
        [id, account, toStroops(amount).toString(), ref, didDebit],
      );
      return didDebit;
    });
    return { id, account, amount, ref, debited };
  }

  /**
   * Mark a reservation SETTLED after a SUCCESSFUL submit. Single-winner atomic
   * conditional UPDATE: only an OUTSTANDING reservation flips, so a replay or a
   * settle of an already-terminal reservation is a no-op. A settled reservation
   * can never be refunded.
   */
  async settle(reservation: Reservation): Promise<void> {
    await this.pool.query(
      `UPDATE reservations SET state = 'SETTLED', resolved_at = now()
         WHERE id = $1 AND state = 'OUTSTANDING'`,
      [reservation.id],
    );
  }

  /**
   * Restore a previously reserved amount after a FAILED submit. The single
   * winner is the conditional UPDATE that flips OUTSTANDING -> REFUNDED
   * (cross-instance safe). If the winning row did not actually debit, the state
   * is flipped with no balance restore (matches the JSON edge path). Otherwise
   * the balance is restored and the net debit counter decremented (pruned at
   * zero) so a genuine retry re-debits. A settled/already-refunded/unknown
   * reservation is a no-op.
   */
  async refund(reservation: Reservation): Promise<void> {
    await this.tx(async (client) => {
      const res = await client.query<{
        account: string;
        amount_stroops: string;
        ref: string;
        debited: boolean;
      }>(
        `UPDATE reservations SET state = 'REFUNDED', resolved_at = now()
           WHERE id = $1 AND state = 'OUTSTANDING'
           RETURNING account, amount_stroops, ref, debited`,
        [reservation.id],
      );
      const rec = res.rows[0];
      // Unknown or already-terminal reservation, or a no-op reserve that did not
      // debit: state is flipped (if it was OUTSTANDING) but no credit is restored.
      if (!rec || !rec.debited) {
        return;
      }
      await this.lockAccount(client, rec.account);
      const amount = BigInt(rec.amount_stroops);
      await client.query(
        `UPDATE ledger_accounts
            SET balance_stroops = balance_stroops + $2,
                history_total   = history_total + 1,
                updated_at      = now()
          WHERE account = $1`,
        [rec.account, amount.toString()],
      );
      await this.bumpCounter(client, rec.account, 'debit', rec.ref, -1);
      await this.pushHistory(client, rec.account, 'credit', amount, `refund:${rec.ref}`);
    });
  }

  /**
   * Record sponsored reserves the relayer fronts for a funding account and
   * return the new held total. Refund-aware by `ref` when supplied: a positive
   * hold-net is an outstanding hold => no-op returning the current held total.
   * Enforces the per-funder cap under the row lock: throws
   * `sponsored_held_exceeded` when the addition would exceed `maxHeld`.
   */
  async holdReserve(
    account: string,
    amount: string,
    maxHeld: string,
    ref?: string,
  ): Promise<string> {
    return this.tx(async (client) => {
      const row = await this.lockAccount(client, account);
      if (ref) {
        const net = await this.refNet(client, account, 'hold', ref);
        if (net > 0) {
          return fromStroops(BigInt(row.sponsored_held_stroops));
        }
      }
      const next = BigInt(row.sponsored_held_stroops) + toStroops(amount);
      if (next > toStroops(maxHeld)) {
        throw new Error('sponsored_held_exceeded');
      }
      await client.query(
        `UPDATE ledger_accounts
            SET sponsored_held_stroops = $2,
                hold_history_total     = hold_history_total + $3,
                updated_at             = now()
          WHERE account = $1`,
        [account, next.toString(), ref ? 1 : 0],
      );
      if (ref) {
        await this.bumpCounter(client, account, 'hold', ref, 1);
        await this.pushHistory(client, account, 'hold', toStroops(amount), ref);
      }
      return fromStroops(next);
    });
  }

  /**
   * Release previously held sponsored reserves (clamped at zero) and return the
   * new held total. When `ref` is supplied a release with no outstanding hold
   * (hold-net <= 0) is a no-op; otherwise the counter is decremented (pruned at
   * zero) so a genuine retry can re-hold. Calls without a `ref` keep the legacy
   * unconditional-subtract behaviour.
   */
  async releaseReserve(account: string, amount: string, ref?: string): Promise<string> {
    return this.tx(async (client) => {
      const row = await this.lockAccount(client, account);
      if (ref) {
        const net = await this.refNet(client, account, 'hold', ref);
        if (net <= 0) {
          return fromStroops(BigInt(row.sponsored_held_stroops));
        }
      }
      let next = BigInt(row.sponsored_held_stroops) - toStroops(amount);
      if (next < 0n) next = 0n;
      await client.query(
        `UPDATE ledger_accounts
            SET sponsored_held_stroops = $2,
                hold_history_total     = hold_history_total + $3,
                updated_at             = now()
          WHERE account = $1`,
        [account, next.toString(), ref ? 1 : 0],
      );
      if (ref) {
        await this.bumpCounter(client, account, 'hold', ref, -1);
        await this.pushHistory(client, account, 'release', toStroops(amount), ref);
      }
      return fromStroops(next);
    });
  }
}
