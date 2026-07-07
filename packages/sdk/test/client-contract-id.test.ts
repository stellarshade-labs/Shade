import { describe, it, expect } from 'vitest';
import { StealthClient } from '../src/client.js';
import { ContractIdRequiredError } from '../src/errors.js';

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
          contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGABAX',
        }),
    ).not.toThrow();
  });

  it('does NOT throw for local (built-in default contractId)', () => {
    expect(
      () => new StealthClient({ network: 'local', methods: ['pool'] }),
    ).not.toThrow();
  });
});
