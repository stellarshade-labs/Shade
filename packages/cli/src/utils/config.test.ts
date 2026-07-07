import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The payment cache lives at `<homedir>/.stealth/horizon-payments-<net>.json`.
// Mock `os.homedir` to a throwaway temp dir so the module-level CONFIG_DIR in
// config.ts resolves offline and never touches the real home directory.
const { TEMP_HOME } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-config-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual }, homedir: () => TEMP_HOME };
});

const {
  saveHorizonPayments,
  loadHorizonPayments,
  findHorizonPayment,
  clearHorizonPayments,
} = await import('./config.js');

type PP = Parameters<typeof saveHorizonPayments>[1][number];

const NET = 'local' as const;

function payment(over: Partial<PP> = {}): PP {
  return {
    stealthAddress: 'GA'.padEnd(56, 'A'),
    ephemeralPubKey: 'ab'.repeat(32),
    token: 'native',
    amount: 5,
    txHash: 'HASH1',
    ...over,
  };
}

describe('horizon payments cache', () => {
  beforeEach(() => clearHorizonPayments(NET));
  afterEach(() => clearHorizonPayments(NET));

  it('returns an empty array when nothing is persisted', () => {
    expect(loadHorizonPayments(NET)).toEqual([]);
  });

  it('persists a discovered payment and resolves it by stealth address', () => {
    const p = payment();
    saveHorizonPayments(NET, [p]);

    const found = findHorizonPayment(NET, p.stealthAddress);
    expect(found).toBeDefined();
    expect(found?.ephemeralPubKey).toBe(p.ephemeralPubKey);
    expect(found?.amount).toBe(5);
  });

  it('carries token/asset/claimableBalanceId through for token payments', () => {
    const issuer = 'GISSUER'.padEnd(56, 'X');
    const p = payment({
      stealthAddress: 'GB'.padEnd(56, 'B'),
      token: `USDC:${issuer}`,
      asset: `USDC:${issuer}`,
      claimableBalanceId: '00'.repeat(36),
      txHash: 'HASH2',
    });
    saveHorizonPayments(NET, [p]);

    const found = findHorizonPayment(NET, p.stealthAddress);
    expect(found?.token).toBe(`USDC:${issuer}`);
    expect(found?.asset).toBe(`USDC:${issuer}`);
    expect(found?.claimableBalanceId).toBe('00'.repeat(36));
  });

  it('merges new finds with existing ones (cursor-advanced scan keeps history)', () => {
    const first = payment({ stealthAddress: 'GC'.padEnd(56, 'C'), txHash: 'H1' });
    const second = payment({ stealthAddress: 'GD'.padEnd(56, 'D'), txHash: 'H2' });
    saveHorizonPayments(NET, [first]);
    saveHorizonPayments(NET, [second]);

    const all = loadHorizonPayments(NET);
    expect(all).toHaveLength(2);
    expect(findHorizonPayment(NET, first.stealthAddress)).toBeDefined();
    expect(findHorizonPayment(NET, second.stealthAddress)).toBeDefined();
  });

  it('de-duplicates on (stealthAddress, txHash, claimableBalanceId)', () => {
    const p = payment();
    saveHorizonPayments(NET, [p]);
    saveHorizonPayments(NET, [{ ...p, amount: 99 }]);

    const all = loadHorizonPayments(NET);
    expect(all).toHaveLength(1);
    expect(all[0]?.amount).toBe(99);
  });

  it('clears the cache', () => {
    saveHorizonPayments(NET, [payment()]);
    clearHorizonPayments(NET);
    expect(loadHorizonPayments(NET)).toEqual([]);
  });
});
