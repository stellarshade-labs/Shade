import { describe, it, expect } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import { StealthClient } from '../src/client.js';
import { ContractIdRequiredError, UnsupportedNetworkError } from '../src/errors.js';

describe('StealthClient contractId validation', () => {
  it("throws for network 'testnet' with pool enabled and no contractId", () => {
    expect(
      () => new StealthClient({ network: 'testnet', methods: ['pool'] }),
    ).toThrow(ContractIdRequiredError);
  });

  it('names the network in the error message', () => {
    expect(() => new StealthClient({ network: 'testnet' })).toThrow(
      /contractId is required for network 'testnet'/,
    );
  });

  it('does NOT throw when only account is enabled (no pool)', () => {
    expect(
      () => new StealthClient({ network: 'testnet', methods: ['account'] }),
    ).not.toThrow();
  });

  it('does NOT throw for testnet when a contractId is supplied', () => {
    expect(
      () =>
        new StealthClient({
          network: 'testnet',
          methods: ['pool'],
          contractId: StrKey.encodeContract(Buffer.alloc(32)),
        }),
    ).not.toThrow();
  });

  it("rejects the removed 'local' network with UnsupportedNetworkError (JS-caller guard)", () => {
    // The type system already forbids this; the cast simulates a plain-JS
    // caller (or a stale persisted config) still passing 'local'.
    expect(
      () =>
        new StealthClient({
          network: 'local' as unknown as 'testnet',
          methods: ['account'],
        }),
    ).toThrow(UnsupportedNetworkError);
  });
});
