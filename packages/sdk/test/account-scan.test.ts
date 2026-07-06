import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@stealth/crypto';
import { Networks } from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import { HorizonClient, type FetchLike } from '../src/horizon.js';
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

/** Build a stub fetch serving synthetic Horizon fixtures. */
function makeStubFetch(opts: {
  transactions: unknown[];
  operationsByTx: Record<string, unknown[]>;
}): FetchLike {
  return async (url: string) => {
    if (url.includes('/transactions/') && url.includes('/operations')) {
      const hash = url.split('/transactions/')[1]!.split('/operations')[0]!;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: { records: opts.operationsByTx[hash] ?? [] },
        }),
      };
    }
    if (url.includes('/transactions?')) {
      // Only serve records once; a resumed cursor returns empty.
      const hasCursor = url.includes('cursor=');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: { records: hasCursor ? [] : opts.transactions },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe('account method memo roundtrip', () => {
  it('encodes/decodes R as a 32-byte MemoHash exactly', () => {
    const R = new Uint8Array(randomBytes(32));
    const b64 = Buffer.from(R).toString('base64');
    const back = new Uint8Array(Buffer.from(b64, 'base64'));
    expect(back.length).toBe(32);
    expect(Buffer.from(back).toString('hex')).toBe(
      Buffer.from(R).toString('hex'),
    );
  });
});

describe('account scan', () => {
  it('finds exactly the one matching payment among decoys', async () => {
    const { keys, raw } = keysToHex();

    // The matching send: sender derives a stealth address for OUR meta-address.
    const ephemeralPrivKey = new Uint8Array(randomBytes(32));
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      ephemeralPrivKey,
    );

    // A decoy send: derived for a DIFFERENT meta-address (not ours).
    const other = generateMetaAddress();
    const decoy = deriveStealthAddressWithSecret(
      other.metaAddress.spendPubKey,
      other.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_MINE',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
      },
      {
        id: 't2',
        hash: 'HASH_DECOY',
        paging_token: '2',
        memo_type: 'hash',
        memo: Buffer.from(decoy.ephemeralPubKey).toString('base64'),
        successful: true,
      },
      {
        id: 't3',
        hash: 'HASH_NOMEMO',
        paging_token: '3',
        memo_type: 'none',
        successful: true,
      },
    ];

    const operationsByTx: Record<string, unknown[]> = {
      HASH_MINE: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_MINE',
          account: mine.stealthAddress,
          starting_balance: '42.0000000',
        },
      ],
      HASH_DECOY: [
        {
          id: 'o2',
          type: 'create_account',
          transaction_hash: 'HASH_DECOY',
          account: decoy.stealthAddress,
          starting_balance: '10.0000000',
        },
      ],
    };

    const horizon = new HorizonClient(
      'http://localhost:8000',
      makeStubFetch({ transactions, operationsByTx }),
    );
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);

    const { payments, cursor } = await adapter.scan(keys);

    expect(payments).toHaveLength(1);
    expect(payments[0]!.stealthAddress).toBe(mine.stealthAddress);
    expect(payments[0]!.amount).toBe(42);
    expect(payments[0]!.method).toBe('account');
    expect(payments[0]!.txHash).toBe('HASH_MINE');
    expect(cursor).toBe('3');
  });

  it('matches a Payment op (op_already_exists retry path)', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_PAY',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    const operationsByTx = {
      HASH_PAY: [
        {
          id: 'o1',
          type: 'payment',
          transaction_hash: 'HASH_PAY',
          to: mine.stealthAddress,
          amount: '7.5000000',
          asset_type: 'native',
        },
      ],
    };

    const horizon = new HorizonClient(
      'http://localhost:8000',
      makeStubFetch({ transactions, operationsByTx }),
    );
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);
    const { payments } = await adapter.scan(keys);

    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe(7.5);
  });
});
