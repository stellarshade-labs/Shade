import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonCreditLedger, toStroops, fromStroops } from './ledger.js';
import { describeCreditLedgerSpec } from './ledger.spec-shared.js';

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

// Run the backend-agnostic CreditLedger contract against the JSON-file backend.
// The same spec will later be run against other backends (e.g. Postgres) via
// their own factory, so no assertion here is backend-specific.
describeCreditLedgerSpec('CreditLedger (JSON file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'credit-ledger.json');
  return {
    ledger: new JsonCreditLedger(file),
    reopen: async () => new JsonCreditLedger(file),
    cleanup: async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
});
