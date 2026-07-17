import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import { StealthClient } from '../src/client.js';
import type { StealthKeys } from '../src/types.js';

function keysToHex(): {
  keys: StealthKeys;
  raw: ReturnType<typeof generateMetaAddress>;
} {
  const raw = generateMetaAddress();
  const keys: StealthKeys = {
    metaAddress: encodeMetaAddress(raw.metaAddress),
    spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
  };
  return { keys, raw };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stub Horizon: one hash-memo tx (paging_token NEXT_TOKEN) carrying a native
 * send to `live`, plus the account probe for the balance path. Captures every
 * requested URL so tests can assert exactly what cursor was forwarded.
 */
function stubHorizon(live: {
  stealthAddress: string;
  ephemeralPubKey: Uint8Array;
}): string[] {
  const urls: string[] = [];
  const transactions = [
    {
      id: 't-new',
      hash: 'HASH_NEW',
      paging_token: '43',
      memo_type: 'hash',
      memo: Buffer.from(live.ephemeralPubKey).toString('base64'),
      successful: true,
    },
  ];
  const operations = [
    {
      id: 'o-new',
      type: 'create_account',
      transaction_hash: 'HASH_NEW',
      account: live.stealthAddress,
      starting_balance: '17.0000000',
    },
  ];

  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    if (url.includes('/accounts/')) {
      const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
      if (address !== live.stealthAddress) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: live.stealthAddress,
          sequence: '1',
          balances: [{ asset_type: 'native', balance: '17.0000000' }],
        }),
      };
    }
    if (url.includes('/transactions/') && url.includes('/operations')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records: operations } }),
      };
    }
    if (url.includes('/transactions?')) {
      // The single page holds every tx regardless of cursor; a short page
      // ends the walk, so each balance call issues exactly one page request.
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records: transactions } }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  return urls;
}

describe('balance() account-phase cursor reuse', () => {
  it('balanceWithCursor forwards opts.cursor into the Horizon walk and returns the advanced cursor', async () => {
    const { keys, raw } = keysToHex();
    const live = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );
    const urls = stubHorizon(live);

    const client = new StealthClient({ network: 'testnet', methods: ['account'] });
    const result = await client.balanceWithCursor(keys, {
      cursor: { account: '42' },
    });

    // The persisted cursor was forwarded to Horizon (no full-history rescan).
    const txPages = urls.filter((u) => u.includes('/transactions?'));
    expect(txPages).toHaveLength(1);
    expect(txPages[0]).toContain('cursor=42');

    // The advanced cursor (the last paging token seen) is surfaced to persist.
    expect(result.cursor.account).toBe('43');

    // The live payment is reported with its full row (claim needs these).
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]).toMatchObject({
      stealthAddress: live.stealthAddress,
      token: 'native',
      amountStroops: '170000000',
      txHash: 'HASH_NEW',
    });
  });

  it('balance(keys, opts) forwards the cursor too and still returns plain Balance rows', async () => {
    const { keys, raw } = keysToHex();
    const live = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );
    const urls = stubHorizon(live);

    const client = new StealthClient({ network: 'testnet', methods: ['account'] });
    const balances = await client.balance(keys, { cursor: { account: '42' } });

    expect(urls.find((u) => u.includes('/transactions?'))).toContain('cursor=42');
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      stealthAddress: live.stealthAddress,
      token: 'native',
      amount: 17,
      amountStroops: '170000000',
    });
  });

  it('balance(keys) with no opts scans from the beginning, exactly as before', async () => {
    const { keys, raw } = keysToHex();
    const live = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );
    const urls = stubHorizon(live);

    const client = new StealthClient({ network: 'testnet', methods: ['account'] });
    const balances = await client.balance(keys);

    // No cursor parameter on the first (and only) transactions page request.
    const txPages = urls.filter((u) => u.includes('/transactions?'));
    expect(txPages).toHaveLength(1);
    expect(txPages[0]).not.toContain('cursor=');

    expect(balances).toHaveLength(1);
    expect(balances[0]!.stealthAddress).toBe(live.stealthAddress);
  });
});
