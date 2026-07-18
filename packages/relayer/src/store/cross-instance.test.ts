import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { PostgresCreditLedger } from './postgres.js';

/**
 * Cross-instance ledger behaviour: two PostgresCreditLedger instances (separate
 * pools, as two relayer processes would have) backed by ONE database + schema.
 * Complements postgres.test.ts (single-instance contract + concurrent recovery)
 * by proving the money invariants hold when two live instances share the store.
 *
 * Runs only when TEST_DATABASE_URL points at a reachable Postgres (docker or a
 * cloud instance); skips otherwise so the default `npm test` needs no backend.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgresCreditLedger cross-instance', () => {
  const ACC = 'GALICE';
  let schema: string;
  let poolA: Pool;
  let poolB: Pool;
  let ledgerA: PostgresCreditLedger;
  let ledgerB: PostgresCreditLedger;

  const schemaPool = (s: string): Pool =>
    new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${s}`, max: 4 });

  beforeEach(async () => {
    schema = `xinst_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const bootstrap = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    await bootstrap.end();

    poolA = schemaPool(schema);
    poolB = schemaPool(schema);
    ledgerA = new PostgresCreditLedger(poolA);
    // Only one instance needs to run migrations; init() is idempotent under the
    // advisory lock, but initialise A then construct B over the same schema.
    await ledgerA.init();
    ledgerB = new PostgresCreditLedger(poolB);
    await ledgerB.init();
  });

  afterEach(async () => {
    await poolA.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await Promise.allSettled([poolA.end(), poolB.end()]);
  });

  it('a credit on instance A is immediately visible on instance B', async () => {
    await ledgerA.credit(ACC, '10', 'TX1');
    expect(await ledgerB.getBalance(ACC)).toBe('10.0000000');
    expect(await ledgerB.hasConsumed('TX1')).toBe(true);
  });

  it('the same deposit tx claimed on both instances credits exactly once', async () => {
    await ledgerA.credit(ACC, '10', 'DEP');
    // B replays the same deposit hash — idempotency is enforced in the DB, not
    // in per-process memory, so the second credit is rejected.
    await expect(ledgerB.credit(ACC, '10', 'DEP')).rejects.toThrow('tx_already_claimed');
    expect(await ledgerA.getBalance(ACC)).toBe('10.0000000');
  });

  it('concurrent reserves across instances against a one-fee balance: exactly one debits', async () => {
    // Balance covers exactly one 2-XLM fee. Two instances each try to reserve a
    // DISTINCT fee (different refs => not idempotent no-ops) at the same time.
    await ledgerA.credit(ACC, '2', 'TX1');

    const results = await Promise.allSettled([
      ledgerA.reserve(ACC, '2', 'relay:a'),
      ledgerB.reserve(ACC, '2', 'relay:b'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // The row lock serializes them: one debits, the other sees a zero balance
    // and throws insufficient_credit.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      'insufficient_credit',
    );
    expect(await ledgerA.getBalance(ACC)).toBe('0.0000000');
  });

  it('a reservation opened on A can be settled on B (shared reservation state)', async () => {
    await ledgerA.credit(ACC, '5', 'TX1');
    const reservation = await ledgerA.reserve(ACC, '2', 'relay:x');
    expect(await ledgerB.getBalance(ACC)).toBe('3.0000000');
    // B settles the reservation A opened — terminal state is in the DB.
    await ledgerB.settle(reservation);
    // A second settle (from either instance) is a no-op, and a refund after
    // settle must NOT restore the balance.
    await ledgerA.refund(reservation);
    expect(await ledgerB.getBalance(ACC)).toBe('3.0000000');
  });

  it('a partial settle from a second instance credits the remainder exactly once', async () => {
    await ledgerA.credit(ACC, '5', 'TX1');
    const reservation = await ledgerA.reserve(ACC, '2', 'relay:partial');
    // B settles at the on-chain fee_charged (1.5): the 0.5 remainder is
    // credited back atomically with the terminal flip.
    await ledgerB.settle(reservation, '1.5000000');
    expect(await ledgerA.getBalance(ACC)).toBe('3.5000000');
    // Replays from either instance — settle again or refund — cannot
    // double-credit: the conditional flip already had its single winner.
    await ledgerA.settle(reservation, '1.5000000');
    await ledgerA.refund(reservation);
    await ledgerB.refund(reservation);
    expect(await ledgerB.getBalance(ACC)).toBe('3.5000000');
  });
});
