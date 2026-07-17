import { describe, it, expect, afterEach } from 'vitest';
import type { CreditLedger } from './ledger.js';
import { toStroops, fromStroops } from './ledger.js';

const ACC = 'GABCDEF00000000000000000000000000000000000000000000000000';

/**
 * A backend factory for the shared {@link CreditLedger} spec. Returns a fresh,
 * empty ledger plus a `reopen` that constructs a NEW ledger instance backed by
 * the SAME durable store (to exercise restart durability) and a `cleanup` that
 * tears the backing store down.
 */
export interface CreditLedgerHarness {
  ledger: CreditLedger;
  /** Open a new ledger instance over the same backing store (restart durability). */
  reopen: () => Promise<CreditLedger>;
  /** Tear down the backing store. */
  cleanup: () => Promise<void>;
}

/**
 * The backend-agnostic behavioural contract for a {@link CreditLedger}. Every
 * implementation (JSON file today, Postgres/etc. later) runs this identical
 * assertion set via its own `makeHarness` factory. Split out so no coverage is
 * lost when new backends are added.
 */
export function describeCreditLedgerSpec(
  name: string,
  makeHarness: () => Promise<CreditLedgerHarness>,
): void {
  describe(name, () => {
    let harness: CreditLedgerHarness | null = null;

    async function open(): Promise<CreditLedger> {
      harness = await makeHarness();
      return harness.ledger;
    }

    afterEach(async () => {
      if (harness) {
        await harness.cleanup();
        harness = null;
      }
    });

    it('credits a deposit and persists atomically', async () => {
      const ledger = await open();
      const acct = await ledger.credit(ACC, '5.0000000', 'TX1');
      expect(acct.balance).toBe('5.0000000');

      // A fresh instance reads back the persisted state.
      const reopened = await harness!.reopen();
      expect(await reopened.getBalance(ACC)).toBe('5.0000000');
      expect(await reopened.hasConsumed('TX1')).toBe(true);
    });

    it('rejects a duplicate txHash claim', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      await expect(ledger.credit(ACC, '5', 'TX1')).rejects.toThrow('tx_already_claimed');
      expect(await ledger.getBalance(ACC)).toBe('5.0000000');
    });

    it('debits and tracks history', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '10', 'TX1');
      const acct = await ledger.debit(ACC, '3.5', 'ref-1');
      expect(acct.balance).toBe('6.5000000');
      expect(acct.history.map((h) => h.type)).toEqual(['credit', 'debit']);
    });

    it('rejects a debit that exceeds the balance', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '1', 'TX1');
      await expect(ledger.debit(ACC, '2', 'ref')).rejects.toThrow('insufficient_credit');
      expect(await ledger.getBalance(ACC)).toBe('1.0000000');
    });

    it('hasSufficient reflects available credit', async () => {
      const ledger = await open();
      expect(await ledger.hasSufficient(ACC, '0.0000001')).toBe(false);
      await ledger.credit(ACC, '2', 'TX1');
      expect(await ledger.hasSufficient(ACC, '2')).toBe(true);
      expect(await ledger.hasSufficient(ACC, '2.0000001')).toBe(false);
    });

    it('returns null for unknown accounts', async () => {
      const ledger = await open();
      expect(await ledger.getBalance('GUNKNOWN')).toBeNull();
      expect(await ledger.getAccount('GUNKNOWN')).toBeNull();
    });

    it('serializes two concurrent reserves so only one succeeds', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '1', 'TX1'); // exactly one fee of credit

      const results = await Promise.allSettled([
        ledger.reserve(ACC, '1', 'ref-a'),
        ledger.reserve(ACC, '1', 'ref-b'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
        'insufficient_credit',
      );
      expect(await ledger.getBalance(ACC)).toBe('0.0000000');
    });

    it('refund restores a reserved balance and is idempotent', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      const reservation = await ledger.reserve(ACC, '2', 'ref-1');
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
      await ledger.refund(reservation);
      expect(await ledger.getBalance(ACC)).toBe('5.0000000');
      // A repeated refund of the same reservation is a no-op (no over-credit).
      await ledger.refund(reservation);
      expect(await ledger.getBalance(ACC)).toBe('5.0000000');
    });

    it('does not double-charge a repeated debit ref', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      await ledger.debit(ACC, '2', 'dup-ref');
      await ledger.debit(ACC, '2', 'dup-ref');
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
    });

    it('re-debits the same ref after a refund (no free retry)', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '2', 'TX1'); // room for two 1-XLM fees total

      // First reserve debits; submit "throws" so we refund.
      const r1 = await ledger.reserve(ACC, '1', 'same-ref');
      expect(await ledger.getBalance(ACC)).toBe('1.0000000');
      await ledger.refund(r1);
      expect(await ledger.getBalance(ACC)).toBe('2.0000000');

      // The client retries the SAME signed tx (=> same ref). It must re-debit,
      // not hit the idempotency no-op and submit for free.
      await ledger.reserve(ACC, '1', 'same-ref');
      expect(await ledger.getBalance(ACC)).toBe('1.0000000');
    });

    it('keeps a plain duplicate reserve idempotent with no refund between', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      await ledger.reserve(ACC, '2', 'dup-ref');
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
      // No refund in between: a duplicate reserve of the same ref is a no-op.
      await ledger.reserve(ACC, '2', 'dup-ref');
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
    });

    it('reserve -> settle -> refund is a no-op (the charge stays)', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      const r = await ledger.reserve(ACC, '2', 'ref-settle');
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
      await ledger.settle(r);
      // A refund after a settled reservation must NOT restore the charge.
      await ledger.refund(r);
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
    });

    it('a settled reservation cannot be refunded by a replay of the same id', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      const r = await ledger.reserve(ACC, '1', 'ref-replay');
      await ledger.settle(r);
      // Replay: same reservation object, refunded twice — stays a no-op.
      await ledger.refund(r);
      await ledger.refund(r);
      expect(await ledger.getBalance(ACC)).toBe('4.0000000');
    });

    it('reserve -> refund restores exactly once; a second refund is a no-op', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '5', 'TX1');
      const r = await ledger.reserve(ACC, '2', 'ref-once');
      expect(await ledger.getBalance(ACC)).toBe('3.0000000');
      await ledger.refund(r);
      expect(await ledger.getBalance(ACC)).toBe('5.0000000');
      await ledger.refund(r);
      expect(await ledger.getBalance(ACC)).toBe('5.0000000');
    });

    it('holdReserve tracks sponsoredHeld and enforces the cap', async () => {
      const ledger = await open();
      const held = await ledger.holdReserve(ACC, '1', '2');
      expect(held).toBe('1.0000000');
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('1.0000000');
      await ledger.holdReserve(ACC, '1', '2');
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('2.0000000');
      // Exceeding the cap throws and does not increment.
      await expect(ledger.holdReserve(ACC, '1', '2')).rejects.toThrow(
        'sponsored_held_exceeded',
      );
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('2.0000000');
    });

    it('holdReserve is idempotent by ref: a repeated ref does not double-increment', async () => {
      const ledger = await open();
      const ref = 'sponsor-claim:deadbeef';
      const first = await ledger.holdReserve(ACC, '1', '5', ref);
      expect(first).toBe('1.0000000');
      // A genuine retry of the SAME signed tx (same ref) is a no-op.
      const second = await ledger.holdReserve(ACC, '1', '5', ref);
      expect(second).toBe('1.0000000');
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('1.0000000');
      // A DIFFERENT ref still increments normally.
      await ledger.holdReserve(ACC, '1', '5', 'sponsor-claim:feedface');
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('2.0000000');
    });

    it('re-holds the same ref after a release (retry-after-failure path)', async () => {
      const ledger = await open();
      const ref = 'sponsor-claim:cafebabe';
      // Attempt 1: hold the sponsored reserve, then submit fails so we release it.
      await ledger.holdReserve(ACC, '1', '5', ref);
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('1.0000000');
      await ledger.releaseReserve(ACC, '1', ref);
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('0.0000000');
      // Genuine retry of the SAME signed tx (same ref) must re-apply the hold,
      // not hit the idempotency no-op (which would under-count held reserves).
      await ledger.holdReserve(ACC, '1', '5', ref);
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('1.0000000');
    });

    it('does not over-release a ref with no outstanding hold', async () => {
      const ledger = await open();
      const ref = 'sponsor-claim:0badf00d';
      await ledger.holdReserve(ACC, '1', '5', ref);
      await ledger.releaseReserve(ACC, '1', ref);
      // A second release of the already-released ref is a no-op (stays at zero).
      await ledger.releaseReserve(ACC, '1', ref);
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('0.0000000');
    });

    it('bounds per-account history under a net-zero reserve/refund churn loop', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '1', 'TX1'); // room for exactly one fee at a time

      // Reserve then refund the SAME signed tx many times: net balance stays put
      // but a naive implementation would append two history rows per cycle without
      // bound. Verify the trail is capped.
      for (let i = 0; i < 500; i++) {
        const r = await ledger.reserve(ACC, '1', 'churn-ref');
        await ledger.refund(r);
      }

      expect(await ledger.getBalance(ACC)).toBe('1.0000000');
      const acct = (await ledger.getAccount(ACC))!;
      // History is capped (does not grow with the number of cycles).
      expect(acct.history.length).toBeLessThanOrEqual(200);
      // The net debit counter for the ref nets back to zero (pruned away), so the
      // idempotency map does not grow without bound either.
      expect(acct.refCounters?.debit?.['churn-ref']).toBeUndefined();
    });

    it('debit/refund cost does not scale with history length', async () => {
      const ledger = await open();
      await ledger.credit(ACC, '1000', 'TX1');

      // Build up a long history with many distinct debit refs.
      for (let i = 0; i < 400; i++) {
        await ledger.debit(ACC, '0.0000001', `bulk-ref-${i}`);
      }
      const acct = (await ledger.getAccount(ACC))!;
      // History is capped even though 400 distinct debits were applied.
      expect(acct.history.length).toBeLessThanOrEqual(200);
      // Yet the cumulative count of appended entries is preserved for accounting.
      expect(acct.historyTotal).toBeGreaterThanOrEqual(401);

      // A fresh debit and its refund still behave correctly against the capped
      // trail (idempotency/retry decisions come from the O(1) counter, not the
      // rotated history — so a ref rotated out of the trail is NOT re-debited
      // for free while outstanding).
      const r = await ledger.reserve(ACC, '2', 'final-ref');
      expect(await ledger.getBalance(ACC)).toBe(
        fromStroops(toStroops('1000') - toStroops('0.0000001') * 400n - toStroops('2')),
      );
      // Duplicate reserve of the same outstanding ref is a no-op.
      await ledger.reserve(ACC, '2', 'final-ref');
      expect(await ledger.getBalance(ACC)).toBe(
        fromStroops(toStroops('1000') - toStroops('0.0000001') * 400n - toStroops('2')),
      );
      await ledger.refund(r);
      // After refund the same ref re-debits (net counter went back to zero).
      await ledger.reserve(ACC, '2', 'final-ref');
      expect(await ledger.getBalance(ACC)).toBe(
        fromStroops(toStroops('1000') - toStroops('0.0000001') * 400n - toStroops('2')),
      );
    });

    it('bounds hold/release churn history and preserves idempotency', async () => {
      const ledger = await open();
      const ref = 'sponsor-claim:churn';
      for (let i = 0; i < 500; i++) {
        await ledger.holdReserve(ACC, '1', '5', ref);
        await ledger.releaseReserve(ACC, '1', ref);
      }
      expect((await ledger.getAccount(ACC))?.sponsoredHeld).toBe('0.0000000');
      const acct = (await ledger.getAccount(ACC))!;
      expect((acct.holdHistory ?? []).length).toBeLessThanOrEqual(200);
      expect(acct.refCounters?.hold?.[ref]).toBeUndefined();
    });
  });
}
