import { describe, it, expect } from 'vitest';
import { StealthClient } from '../src/client.js';
import {
  MethodRequiredError,
  MethodNotEnabledError,
  MethodNotAvailableError,
  MinimumAmountError,
} from '../src/errors.js';
import { SppAdapter } from '../src/methods/spp.js';

describe('send method resolution', () => {
  const keys = StealthClient.keygen();

  it('throws MethodRequiredError when no method is given', async () => {
    const client = new StealthClient({ network: 'local', methods: ['pool', 'account'] });
    await expect(
      // @ts-expect-error deliberately omitting method
      client.send(keys.metaAddress, 100, 'SXXX'),
    ).rejects.toBeInstanceOf(MethodRequiredError);
  });

  it("'auto' picks 'account' for native amount > 1 when account enabled", async () => {
    const client = new StealthClient({ network: 'local', methods: ['pool', 'account'] });
    // account adapter will fail at network I/O; we only assert it routed to account
    // by checking the rejection is NOT MethodNotEnabledError (would mean it fell
    // back to a disabled method) and NOT MinimumAmountError (amount 2 > 1 clears
    // the account minimum, so reaching that error would mean a routing bug).
    const err = await client
      .send(keys.metaAddress, 2, 'GARBAGE_SECRET', { method: 'auto' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MethodNotEnabledError);
    expect(err).not.toBeInstanceOf(MinimumAmountError);
  });

  it("'auto' picks 'pool' when amount <= 1", async () => {
    const client = new StealthClient({ network: 'local', methods: ['pool'] });
    // pool enabled, account not — auto with amount 1 must resolve to pool (enabled),
    // so it must NOT throw MethodNotEnabledError.
    const err = await client
      .send(keys.metaAddress, 1, 'GARBAGE_SECRET', { method: 'auto' })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(MethodNotEnabledError);
  });

  it("'auto' falls back to 'pool' when account not enabled even for amount > 1", async () => {
    const client = new StealthClient({ network: 'local', methods: ['pool'] });
    const err = await client
      .send(keys.metaAddress, 100, 'GARBAGE_SECRET', { method: 'auto' })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(MethodNotEnabledError);
  });

  it('throws MethodNotEnabledError for a disabled method', async () => {
    const client = new StealthClient({ network: 'local', methods: ['pool'] });
    await expect(
      client.send(keys.metaAddress, 100, 'SXXX', { method: 'account' }),
    ).rejects.toBeInstanceOf(MethodNotEnabledError);
  });
});

describe('spp adapter', () => {
  const keys = StealthClient.keygen();
  const adapter = new SppAdapter();

  it('send throws MethodNotAvailableError', async () => {
    await expect(
      adapter.send({ metaAddress: keys.metaAddress, amount: 5, senderSecret: 'S' }),
    ).rejects.toBeInstanceOf(MethodNotAvailableError);
  });

  it('scan throws MethodNotAvailableError', async () => {
    await expect(adapter.scan(keys)).rejects.toBeInstanceOf(
      MethodNotAvailableError,
    );
  });

  it('claim throws MethodNotAvailableError', async () => {
    await expect(
      adapter.claim(
        {
          stealthAddress: 'G',
          ephemeralPubKey: '00',
          token: 'native',
          amount: 1,
          method: 'spp',
        },
        'GDEST',
        { keys },
      ),
    ).rejects.toBeInstanceOf(MethodNotAvailableError);
  });
});
