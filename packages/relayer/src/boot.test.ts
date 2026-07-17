import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import {
  assertSupportedNetwork,
  resolveRelayerKeypair,
  resolveRequireCredit,
  warnIfEphemeralLedgerPath,
  warnIfPermissiveCors,
} from './boot.js';
import { logger } from './utils/logger.js';

describe('boot hardening', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit never returns; throw instead so the test can observe it
    // without killing the vitest worker.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('assertSupportedNetwork', () => {
    it("exits(1) on the removed 'local' network", () => {
      expect(() => assertSupportedNetwork('local')).toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Unsupported NETWORK',
        expect.objectContaining({ network: 'local' }),
      );
    });

    it('exits(1) on any unknown network label', () => {
      expect(() => assertSupportedNetwork('standalone')).toThrow(
        'process.exit(1)',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("passes 'testnet' through unchanged", () => {
      expect(assertSupportedNetwork('testnet')).toBe('testnet');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveRelayerKeypair (no dev fallback)', () => {
    it('exits(1) when RELAYER_SECRET is missing', () => {
      expect(() => resolveRelayerKeypair(undefined)).toThrow(
        'process.exit(1)',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'RELAYER_SECRET is required (there is no dev fallback)',
        expect.anything(),
      );
    });

    it('exits(1) on an empty-string secret', () => {
      expect(() => resolveRelayerKeypair('')).toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns the keypair for a valid configured secret', () => {
      const secretKp = Keypair.random();
      const kp = resolveRelayerKeypair(secretKp.secret());
      expect(kp.publicKey()).toBe(secretKp.publicKey());
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveRequireCredit (secure-by-default)', () => {
    it('defaults to credit gating ON with no env', () => {
      const r = resolveRequireCredit(undefined);
      expect(r.requireCredit).toBe(true);
      expect(r.reason).toContain('credit gating is always on');
      expect(r.reason).toContain('RELAYER_REQUIRE_CREDIT=0');
    });

    it('explicit "0" overrides the always-on default to OFF', () => {
      const r = resolveRequireCredit('0');
      expect(r.requireCredit).toBe(false);
      expect(r.reason).toContain('explicit');
    });

    it('explicit "1" keeps gating ON', () => {
      const r = resolveRequireCredit('1');
      expect(r.requireCredit).toBe(true);
      expect(r.reason).toContain('explicit');
    });

    it('treats any explicit non-"1" value as OFF (env var always wins)', () => {
      expect(resolveRequireCredit('true').requireCredit).toBe(false);
      expect(resolveRequireCredit('').requireCredit).toBe(false);
    });
  });

  describe('warnIfEphemeralLedgerPath (no network condition)', () => {
    const persistent = path.resolve('/mnt/shade-volume/credit-ledger.json');

    it('warns when CREDIT_LEDGER_PATH is unset with gating ON', () => {
      warnIfEphemeralLedgerPath(undefined, true);
      expect(warnSpy).toHaveBeenCalledWith(
        'Credit ledger on likely-ephemeral storage',
        expect.anything(),
      );
    });

    it('treats an empty-string path as unset (mirrors ledger.ts fallback)', () => {
      warnIfEphemeralLedgerPath('', true);
      expect(warnSpy).toHaveBeenCalledWith(
        'Credit ledger on likely-ephemeral storage',
        expect.anything(),
      );
    });

    it('warns when the path is under the default ./data directory', () => {
      warnIfEphemeralLedgerPath('./data/credit-ledger.json', true);
      expect(warnSpy).toHaveBeenCalledWith(
        'Credit ledger on likely-ephemeral storage',
        expect.objectContaining({
          creditLedgerPath: path.resolve('./data/credit-ledger.json'),
        }),
      );
    });

    it('warns for nested paths under ./data too', () => {
      const nested = path.join(process.cwd(), 'data', 'nested', 'ledger.json');
      warnIfEphemeralLedgerPath(nested, true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('does not warn when the path points outside ./data', () => {
      warnIfEphemeralLedgerPath(persistent, true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when credit gating is OFF', () => {
      warnIfEphemeralLedgerPath(undefined, false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not treat sibling dirs with a "data" prefix as ephemeral', () => {
      const sibling = path.join(process.cwd(), 'database', 'ledger.json');
      warnIfEphemeralLedgerPath(sibling, true);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('warnIfPermissiveCors (no network condition)', () => {
    it('warns whenever origin is "*"', () => {
      warnIfPermissiveCors('*');
      expect(warnSpy).toHaveBeenCalledWith(
        'Permissive CORS',
        expect.objectContaining({ corsOrigin: '*' }),
      );
    });

    it('does not warn when an explicit origin is configured', () => {
      warnIfPermissiveCors('https://app.example.com');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
