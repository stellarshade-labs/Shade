import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { toStroops } from '../ledger.js';
import { describeCreditLedgerSpec } from '../ledger.spec-shared.js';
import { PostgresCreditLedger } from './postgres.js';
import {
  recoverStaleReservations,
  recoveryThresholdSeconds,
  pruneHistory,
} from './recovery.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const ACC = 'GABCDEF00000000000000000000000000000000000000000000000000';

/**
 * Build a `pg` Pool whose every connection is pinned to `schema` via
 * `search_path`, so all tables the ledger creates and reads live in that
 * per-test schema. Isolating each test in its own schema keeps the parallel
 * cases from colliding on the shared database.
 */
function makeSchemaPool(schema: string): Pool {
  return new Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 5,
  });
}

/** A fresh, collision-free schema identifier for one test. */
function freshSchema(): string {
  return `shade_test_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Harness factory for the shared {@link describeCreditLedgerSpec}. Each call
 * creates a brand-new schema (via a bootstrap connection), then a schema-pinned
 * pool + an initialised {@link PostgresCreditLedger}. `reopen` builds a new
 * ledger instance over the SAME pool+schema (restart durability); `cleanup`
 * drops the schema and closes the pool.
 */
async function makePostgresHarness() {
  const schema = freshSchema();

  const bootstrap = new Pool({ connectionString: DATABASE_URL, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await bootstrap.end();

  const pool = makeSchemaPool(schema);
  const ledger = new PostgresCreditLedger(pool);
  await ledger.init();

  return {
    ledger,
    reopen: async () => new PostgresCreditLedger(pool),
    cleanup: async () => {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

// Backend-agnostic CreditLedger contract against Postgres — the identical spec
// the JSON backend runs. Skipped unless a real database is provided.
describe.skipIf(!DATABASE_URL)('postgres backend', () => {
  describeCreditLedgerSpec('CreditLedger (Postgres)', makePostgresHarness);
});

/**
 * Reservation-recovery job. Seeds OUTSTANDING reservations at controlled ages
 * and verifies the atomic conditional refund reclaims each exactly once,
 * across a re-run and a concurrent two-instance sweep, and never touches a
 * fresh reservation. Skipped unless a real database is provided.
 */
describe.skipIf(!DATABASE_URL)('reservation recovery (Postgres)', () => {
  let schema: string;
  let pool: Pool;
  let ledger: PostgresCreditLedger;

  async function setup() {
    schema = freshSchema();
    const bootstrap = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    await bootstrap.end();
    pool = makeSchemaPool(schema);
    ledger = new PostgresCreditLedger(pool);
    await ledger.init();
  }

  afterEach(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  });

  /**
   * Back-date an OUTSTANDING reservation's `created_at` so a sweep sees it as
   * abandoned. Returns the reservation id. `ageSeconds` is subtracted from now.
   */
  async function seedAgedReservation(
    account: string,
    amount: string,
    ref: string,
    ageSeconds: number,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO reservations (id, account, amount_stroops, ref, debited, state, created_at)
         VALUES ($1, $2, $3, $4, true, 'OUTSTANDING', now() - ($5 * interval '1 second'))`,
      [id, account, toStroops(amount).toString(), ref, ageSeconds],
    );
    return id;
  }

  it('refunds an aged OUTSTANDING reservation exactly once (balance + counter restored)', async () => {
    await setup();
    // Credit then debit under a ref, leaving a matching OUTSTANDING reservation
    // whose credit was already taken — the exact crash-mid-reserve shape.
    await ledger.credit(ACC, '5', 'TX1');
    await ledger.debit(ACC, '2', 'relay:crashed');
    expect(await ledger.getBalance(ACC)).toBe('3.0000000');
    // The debit above created the net counter; confirm it is present.
    let counter = await pool.query(
      "SELECT net FROM ref_counters WHERE account = $1 AND kind = 'debit' AND ref = $2",
      [ACC, 'relay:crashed'],
    );
    expect(counter.rows[0]?.net).toBe(1);

    const age = recoveryThresholdSeconds() + 1;
    await seedAgedReservation(ACC, '2', 'relay:crashed', age);

    const reclaimed = await recoverStaleReservations(pool);
    expect(reclaimed).toBe(1);
    // Balance restored...
    expect(await ledger.getBalance(ACC)).toBe('5.0000000');
    // ...and the net debit counter decremented back to zero (pruned away), so a
    // genuine retry of the same signed tx could re-debit.
    counter = await pool.query(
      "SELECT net FROM ref_counters WHERE account = $1 AND kind = 'debit' AND ref = $2",
      [ACC, 'relay:crashed'],
    );
    expect(counter.rowCount).toBe(0);
    // A refund history row was appended.
    const hist = await pool.query(
      "SELECT ref FROM ledger_history WHERE account = $1 AND ref = $2",
      [ACC, 'refund:relay:crashed'],
    );
    expect(hist.rowCount).toBe(1);
  });

  it('a second sweep is a no-op (idempotent)', async () => {
    await setup();
    await ledger.credit(ACC, '5', 'TX1');
    await ledger.debit(ACC, '2', 'relay:crashed');
    const age = recoveryThresholdSeconds() + 1;
    await seedAgedReservation(ACC, '2', 'relay:crashed', age);

    expect(await recoverStaleReservations(pool)).toBe(1);
    expect(await ledger.getBalance(ACC)).toBe('5.0000000');

    // Second sweep reclaims nothing and does not over-credit.
    expect(await recoverStaleReservations(pool)).toBe(0);
    expect(await ledger.getBalance(ACC)).toBe('5.0000000');
  });

  it('a concurrent two-instance sweep reclaims each reservation exactly once', async () => {
    await setup();
    await ledger.credit(ACC, '10', 'TX1');
    await ledger.debit(ACC, '2', 'relay:a');
    await ledger.debit(ACC, '2', 'relay:b');
    expect(await ledger.getBalance(ACC)).toBe('6.0000000');
    const age = recoveryThresholdSeconds() + 1;
    await seedAgedReservation(ACC, '2', 'relay:a', age);
    await seedAgedReservation(ACC, '2', 'relay:b', age);

    // A second pool simulates a second instance sweeping the same database.
    const poolB = makeSchemaPool(schema);
    try {
      const [ra, rb] = await Promise.all([
        recoverStaleReservations(pool),
        recoverStaleReservations(poolB),
      ]);
      // Between the two instances exactly two reservations were reclaimed (no
      // double refund): each row has a single winner.
      expect(ra + rb).toBe(2);
    } finally {
      await poolB.end();
    }
    // Both debits restored, balance back to the credited total exactly once.
    expect(await ledger.getBalance(ACC)).toBe('10.0000000');
  });

  it('leaves a fresh OUTSTANDING reservation untouched', async () => {
    await setup();
    await ledger.credit(ACC, '5', 'TX1');
    // A real, current reservation (not aged) via the ledger API.
    const r = await ledger.reserve(ACC, '2', 'relay:fresh');
    expect(await ledger.getBalance(ACC)).toBe('3.0000000');

    expect(await recoverStaleReservations(pool)).toBe(0);
    // Untouched: still debited, still OUTSTANDING.
    expect(await ledger.getBalance(ACC)).toBe('3.0000000');
    const state = await pool.query('SELECT state FROM reservations WHERE id = $1', [r.id]);
    expect(state.rows[0]?.state).toBe('OUTSTANDING');
  });

  it('prunes ledger_history beyond 200 per (account, kind) group', async () => {
    await setup();
    // 250 distinct credits => 250 credit-kind history rows for one account.
    for (let i = 0; i < 250; i++) {
      await ledger.credit(ACC, '0.0000001', `bulk-${i}`);
    }
    let count = await pool.query(
      "SELECT count(*)::int AS c FROM ledger_history WHERE account = $1 AND kind = 'credit'",
      [ACC],
    );
    expect(count.rows[0]?.c).toBe(250);

    const deleted = await pruneHistory(pool);
    expect(deleted).toBe(50);

    count = await pool.query(
      "SELECT count(*)::int AS c FROM ledger_history WHERE account = $1 AND kind = 'credit'",
      [ACC],
    );
    expect(count.rows[0]?.c).toBe(200);
    // history_total survives pruning (accounting is preserved).
    const total = await pool.query(
      'SELECT history_total FROM ledger_accounts WHERE account = $1',
      [ACC],
    );
    expect(Number(total.rows[0]?.history_total)).toBe(250);
  });
});
