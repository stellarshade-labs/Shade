import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import { StealthClient } from '../src/client.js';
import type { StealthKeys } from '../src/types.js';

function keysToHex(): { keys: StealthKeys; raw: ReturnType<typeof generateMetaAddress> } {
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

describe('client.balance() drops merged native accounts', () => {
  it('a merged (live balance 0) account is absent; an unclaimed one is present', async () => {
    const { keys, raw } = keysToHex();

    const merged = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );
    const live = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_MERGED',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(merged.ephemeralPubKey).toString('base64'),
        successful: true,
      },
      {
        id: 't2',
        hash: 'HASH_LIVE',
        paging_token: '2',
        memo_type: 'hash',
        memo: Buffer.from(live.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    const operationsByTx: Record<string, unknown[]> = {
      HASH_MERGED: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_MERGED',
          account: merged.stealthAddress,
          starting_balance: '42.0000000',
        },
      ],
      HASH_LIVE: [
        {
          id: 'o2',
          type: 'create_account',
          transaction_hash: 'HASH_LIVE',
          account: live.stealthAddress,
          starting_balance: '17.0000000',
        },
      ],
    };
    const accountsByAddress: Record<string, unknown> = {
      // merged: exists but native balance 0.
      [merged.stealthAddress]: {
        id: merged.stealthAddress,
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '0.0000000' }],
      },
      // live: still holds funds.
      [live.stealthAddress]: {
        id: live.stealthAddress,
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '17.0000000' }],
      },
    };

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/accounts/')) {
        const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
        const account = accountsByAddress[address];
        if (!account) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => account };
      }
      if (url.includes('/transactions/') && url.includes('/operations')) {
        const hash = url.split('/transactions/')[1]!.split('/operations')[0]!;
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { records: operationsByTx[hash] ?? [] } }),
        };
      }
      if (url.includes('/transactions?')) {
        const hasCursor = url.includes('cursor=');
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { records: hasCursor ? [] : transactions } }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const client = new StealthClient({ network: 'testnet', methods: ['account'] });
    const balances = await client.balance(keys);

    const addresses = balances.map((b) => b.stealthAddress);
    expect(addresses).toContain(live.stealthAddress);
    expect(addresses).not.toContain(merged.stealthAddress);
  });
});
