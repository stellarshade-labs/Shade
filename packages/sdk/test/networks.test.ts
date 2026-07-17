import { describe, it, expect } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { NETWORKS, getNetworkConfig, type NetworkName } from '../src/soroban.js';
import { ShadeError, UnsupportedNetworkError } from '../src/errors.js';

describe('NETWORKS table (single source of truth)', () => {
  it("contains 'testnet' with the public Stellar endpoints and https-only", () => {
    expect(NETWORKS.testnet).toEqual({
      networkPassphrase: Networks.TESTNET,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      allowHttp: false,
    });
  });

  it("no longer contains the removed 'local' network", () => {
    expect('local' in NETWORKS).toBe(false);
  });

  it('every entry is https-only and fully specified (mainnet-ready shape)', () => {
    // Table-driven on purpose: when 'public' is added post-audit this test
    // covers it automatically without being rewritten.
    for (const def of Object.values(NETWORKS)) {
      expect(def.allowHttp).toBe(false);
      expect(def.rpcUrl).toMatch(/^https:\/\//);
      expect(def.horizonUrl).toMatch(/^https:\/\//);
      expect(def.networkPassphrase.length).toBeGreaterThan(0);
    }
  });
});

describe('getNetworkConfig', () => {
  it('resolves a supported network to its definition plus a connected RPC server', () => {
    const config = getNetworkConfig('testnet');
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(config.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(config.allowHttp).toBe(false);
    expect(config.server).toBeDefined();
    expect(typeof config.server.getTransaction).toBe('function');
  });

  it("throws UnsupportedNetworkError for the removed 'local' (runtime JS guard)", () => {
    const err = (() => {
      try {
        // The cast simulates an untyped JS caller — the union no longer admits it.
        getNetworkConfig('local' as NetworkName);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(UnsupportedNetworkError);
    expect(err).toBeInstanceOf(ShadeError);
    const typed = err as UnsupportedNetworkError;
    expect(typed.code).toBe('unsupported_network');
    expect(typed.network).toBe('local');
    // The supported list mirrors the table, so the message self-updates as
    // networks are added.
    expect(typed.supported).toEqual(Object.keys(NETWORKS));
    expect(typed.message).toContain("'local'");
    expect(typed.message).toContain('testnet');
  });

  it('throws UnsupportedNetworkError for any other unknown name', () => {
    expect(() => getNetworkConfig('futurenet' as NetworkName)).toThrow(
      UnsupportedNetworkError,
    );
    expect(() => getNetworkConfig('' as NetworkName)).toThrow(
      UnsupportedNetworkError,
    );
  });
});
