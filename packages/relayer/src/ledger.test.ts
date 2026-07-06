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
});
