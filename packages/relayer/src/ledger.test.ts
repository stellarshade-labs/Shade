import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CreditLedger, toStroops, fromStroops } from './ledger.js';

const ACC = 'GABCDEF00000000000000000000000000000000000000000000000000';

describe('stroop decimal helpers', () => {
  it('roundtrips decimals without float error', () => {
    expect(fromStroops(toStroops('1.5001'))).toBe('1.5001000');
    expect(fromStroops(toStroops('0.0000001'))).toBe('0.0000001');
    expect(fromStroops(toStroops('100'))).toBe('100.0000000');
  });

  it('adds without float drift', () => {
    const sum = toStroops('0.1') + toStroops('0.2');
    expect(fromStroops(sum)).toBe('0.3000000');
  });

  it('rejects garbage', () => {
    expect(() => toStroops('abc')).toThrow();
  });
});

describe('CreditLedger', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    file = path.join(dir, 'credit-ledger.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('credits a deposit and persists atomically', () => {
    const ledger = new CreditLedger(file);
    const acct = ledger.credit(ACC, '5.0000000', 'TX1');
    expect(acct.balance).toBe('5.0000000');
    expect(fs.existsSync(file)).toBe(true);

    // A fresh instance reads back the persisted state.
    const reopened = new CreditLedger(file);
    expect(reopened.getBalance(ACC)).toBe('5.0000000');
    expect(reopened.hasConsumed('TX1')).toBe(true);
  });

  it('rejects a duplicate txHash claim', () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '5', 'TX1');
    expect(() => ledger.credit(ACC, '5', 'TX1')).toThrow('tx_already_claimed');
    expect(ledger.getBalance(ACC)).toBe('5.0000000');
  });

  it('debits and tracks history', () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '10', 'TX1');
    const acct = ledger.debit(ACC, '3.5', 'ref-1');
    expect(acct.balance).toBe('6.5000000');
    expect(acct.history.map((h) => h.type)).toEqual(['credit', 'debit']);
  });

  it('rejects a debit that exceeds the balance', () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '1', 'TX1');
    expect(() => ledger.debit(ACC, '2', 'ref')).toThrow('insufficient_credit');
    expect(ledger.getBalance(ACC)).toBe('1.0000000');
  });

  it('hasSufficient reflects available credit', () => {
    const ledger = new CreditLedger(file);
    expect(ledger.hasSufficient(ACC, '0.0000001')).toBe(false);
    ledger.credit(ACC, '2', 'TX1');
    expect(ledger.hasSufficient(ACC, '2')).toBe(true);
    expect(ledger.hasSufficient(ACC, '2.0000001')).toBe(false);
  });

  it('returns null for unknown accounts', () => {
    const ledger = new CreditLedger(file);
    expect(ledger.getBalance('GUNKNOWN')).toBeNull();
    expect(ledger.getAccount('GUNKNOWN')).toBeNull();
  });

  it('serializes two concurrent reserves so only one succeeds', async () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '1', 'TX1'); // exactly one fee of credit

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
    expect(ledger.getBalance(ACC)).toBe('0.0000000');
  });

  it('refund restores a reserved balance and is idempotent', async () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '5', 'TX1');
    const reservation = await ledger.reserve(ACC, '2', 'ref-1');
    expect(ledger.getBalance(ACC)).toBe('3.0000000');
    await ledger.refund(reservation);
    expect(ledger.getBalance(ACC)).toBe('5.0000000');
    // A repeated refund of the same reservation is a no-op (no over-credit).
    await ledger.refund(reservation);
    expect(ledger.getBalance(ACC)).toBe('5.0000000');
  });

  it('does not double-charge a repeated debit ref', () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '5', 'TX1');
    ledger.debit(ACC, '2', 'dup-ref');
    ledger.debit(ACC, '2', 'dup-ref');
    expect(ledger.getBalance(ACC)).toBe('3.0000000');
  });

  it('re-debits the same ref after a refund (no free retry)', async () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '2', 'TX1'); // room for two 1-XLM fees total

    // First reserve debits; submit "throws" so we refund.
    const r1 = await ledger.reserve(ACC, '1', 'same-ref');
    expect(ledger.getBalance(ACC)).toBe('1.0000000');
    await ledger.refund(r1);
    expect(ledger.getBalance(ACC)).toBe('2.0000000');

    // The client retries the SAME signed tx (=> same ref). It must re-debit,
    // not hit the idempotency no-op and submit for free.
    await ledger.reserve(ACC, '1', 'same-ref');
    expect(ledger.getBalance(ACC)).toBe('1.0000000');
  });

  it('keeps a plain duplicate reserve idempotent with no refund between', async () => {
    const ledger = new CreditLedger(file);
    ledger.credit(ACC, '5', 'TX1');
    await ledger.reserve(ACC, '2', 'dup-ref');
    expect(ledger.getBalance(ACC)).toBe('3.0000000');
    // No refund in between: a duplicate reserve of the same ref is a no-op.
    await ledger.reserve(ACC, '2', 'dup-ref');
    expect(ledger.getBalance(ACC)).toBe('3.0000000');
  });
});
