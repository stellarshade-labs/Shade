import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
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

  describe('resolveRelayerKeypair', () => {
    it('exits(1) when RELAYER_SECRET is missing on testnet', () => {
      expect(() => resolveRelayerKeypair(undefined, 'testnet')).toThrow(
        'process.exit(1)',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'RELAYER_SECRET is required on non-local networks',
        expect.objectContaining({ network: 'testnet' }),
      );
    });

    it('exits(1) when RELAYER_SECRET is missing on mainnet', () => {
      expect(() => resolveRelayerKeypair(undefined, 'mainnet')).toThrow(
        'process.exit(1)',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits(1) on an empty-string secret on a non-local network', () => {
      expect(() => resolveRelayerKeypair('', 'testnet')).toThrow(
        'process.exit(1)',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('generates a random keypair (with warning) only on local', () => {
      const kp = resolveRelayerKeypair(undefined, 'local');
      expect(StrKey.isValidEd25519PublicKey(kp.publicKey())).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Generated new keypair',
        expect.objectContaining({ publicKey: kp.publicKey() }),
      );
    });

    it('uses the configured secret on any network without exiting', () => {
      const secretKp = Keypair.random();
      const kp = resolveRelayerKeypair(secretKp.secret(), 'testnet');
      expect(kp.publicKey()).toBe(secretKp.publicKey());
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveRequireCredit (secure-by-default matrix)', () => {
    it('defaults OFF when unset on local', () => {
      const r = resolveRequireCredit(undefined, 'local');
      expect(r.requireCredit).toBe(false);
      expect(r.reason).toContain('default for local network');
    });

    it('defaults ON when unset on testnet', () => {
      const r = resolveRequireCredit(undefined, 'testnet');
      expect(r.requireCredit).toBe(true);
      expect(r.reason).toContain('default for non-local network');
    });

    it('defaults ON when unset on mainnet', () => {
      const r = resolveRequireCredit(undefined, 'mainnet');
      expect(r.requireCredit).toBe(true);
      expect(r.reason).toContain('default for non-local network');
    });

    it('explicit "0" overrides the non-local default to OFF', () => {
      const r = resolveRequireCredit('0', 'testnet');
      expect(r.requireCredit).toBe(false);
      expect(r.reason).toContain('explicit');
    });

    it('explicit "1" turns gating ON even on local', () => {
      const r = resolveRequireCredit('1', 'local');
      expect(r.requireCredit).toBe(true);
      expect(r.reason).toContain('explicit');
    });

    it('treats any explicit non-"1" value as OFF (env var always wins)', () => {
      expect(resolveRequireCredit('true', 'mainnet').requireCredit).toBe(false);
      expect(resolveRequireCredit('', 'mainnet').requireCredit).toBe(false);
    });
  });

  describe('warnIfEphemeralLedgerPath', () => {
    const persistent = path.resolve('/mnt/shade-volume/credit-ledger.json');

    it('warns when CREDIT_LEDGER_PATH is unset with gating ON on testnet', () => {
      warnIfEphemeralLedgerPath(undefined, true, 'testnet');
      expect(warnSpy).toHaveBeenCalledWith(
        'Credit ledger on likely-ephemeral storage',
        expect.objectContaining({ network: 'testnet' }),
      );
    });

    it('treats an empty-string path as unset (mirrors ledger.ts fallback)', () => {
      warnIfEphemeralLedgerPath('', true, 'mainnet');
      expect(warnSpy).toHaveBeenCalledWith(
        'Credit ledger on likely-ephemeral storage',
        expect.objectContaining({ network: 'mainnet' }),
      );
    });

    it('warns when the path is under the default ./data directory', () => {
      warnIfEphemeralLedgerPath('./data/credit-ledger.json', true, 'testnet');
      expect(warnSpy).toHaveBeenCalledWith(
        'Credit ledger on likely-ephemeral storage',
        expect.objectContaining({
          creditLedgerPath: path.resolve('./data/credit-ledger.json'),
        }),
      );
    });

    it('warns for nested paths under ./data too', () => {
      const nested = path.join(process.cwd(), 'data', 'nested', 'ledger.json');
      warnIfEphemeralLedgerPath(nested, true, 'testnet');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('does not warn when the path points outside ./data', () => {
      warnIfEphemeralLedgerPath(persistent, true, 'testnet');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn on local, even when unset', () => {
      warnIfEphemeralLedgerPath(undefined, true, 'local');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when credit gating is OFF', () => {
      warnIfEphemeralLedgerPath(undefined, false, 'testnet');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not treat sibling dirs with a "data" prefix as ephemeral', () => {
      const sibling = path.join(process.cwd(), 'database', 'ledger.json');
      warnIfEphemeralLedgerPath(sibling, true, 'testnet');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('warnIfPermissiveCors', () => {
    it('warns when origin is "*" on a non-local network', () => {
      warnIfPermissiveCors('*', 'testnet');
      expect(warnSpy).toHaveBeenCalledWith(
        'Permissive CORS on non-local network',
        expect.objectContaining({ network: 'testnet', corsOrigin: '*' }),
      );
    });

    it('does not warn for "*" on local', () => {
      warnIfPermissiveCors('*', 'local');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when an explicit origin is configured', () => {
      warnIfPermissiveCors('https://app.example.com', 'testnet');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
