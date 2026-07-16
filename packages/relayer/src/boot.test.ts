import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { resolveRelayerKeypair, warnIfPermissiveCors } from './boot.js';
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
