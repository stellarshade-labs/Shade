import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
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
  claimableBalancesByClaimant?: Record<string, unknown[]>;
  accountsByAddress?: Record<string, unknown>;
}): FetchLike {
  return async (url: string) => {
    if (url.includes('/accounts/')) {
      const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
      const account = opts.accountsByAddress?.[address];
      if (!account) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => account };
    }
    if (url.includes('/claimable_balances?claimant=')) {
      const claimant = url.split('claimant=')[1]!.split('&')[0]!;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: opts.claimableBalancesByClaimant?.[claimant] ?? [],
          },
        }),
      };
    }
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
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);

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
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);
    const { payments } = await adapter.scan(keys);

    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe(7.5);
  });

  it('matches a token create_claimable_balance and resolves its balance id', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const ASSET = 'USDC:GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const CB_ID =
      '00000000abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_CB',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    const operationsByTx = {
      HASH_CB: [
        {
          id: 'o0',
          type: 'create_account',
          transaction_hash: 'HASH_CB',
          account: mine.stealthAddress,
          starting_balance: '1.5001000',
        },
        {
          id: 'o1',
          type: 'create_claimable_balance',
          transaction_hash: 'HASH_CB',
          asset: ASSET,
          amount: '100.0000000',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };
    const claimableBalancesByClaimant = {
      [mine.stealthAddress]: [
        {
          id: CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };

    const horizon = new HorizonClient(
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx, claimableBalancesByClaimant }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);
    const { payments } = await adapter.scan(keys);

    // The funding create_account (native 1.5001) is suppressed; only the one
    // logical token payment (the claimable balance) surfaces as spendable.
    expect(payments).toHaveLength(1);
    const token = payments.find((p) => p.claimableBalanceId);
    expect(token).toBeDefined();
    expect(token!.stealthAddress).toBe(mine.stealthAddress);
    expect(token!.asset).toBe(ASSET);
    expect(token!.token).toBe(ASSET);
    expect(token!.amount).toBe(100);
    expect(token!.claimableBalanceId).toBe(CB_ID);
    expect(token!.method).toBe('account');
  });

  it('suppresses the native funding leg of a token send by CB presence, not by a magic amount', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const ASSET = 'USDC:GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const CB_ID =
      '00000000abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_BUNDLE',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
        source_account: 'GSENDERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      },
    ];
    // A create_account whose starting balance is NOT the 1.5001 stub constant,
    // bundled with a matching claimable balance in the SAME tx. Per the fixed
    // contract, the native leg is suppressed because a token CB rides in the
    // same tx (the funding stub), NOT because of any magic amount — only the one
    // logical token payment surfaces.
    const operationsByTx = {
      HASH_BUNDLE: [
        {
          id: 'o0',
          type: 'create_account',
          transaction_hash: 'HASH_BUNDLE',
          account: mine.stealthAddress,
          starting_balance: '3.0000000',
        },
        {
          id: 'o1',
          type: 'create_claimable_balance',
          transaction_hash: 'HASH_BUNDLE',
          asset: ASSET,
          amount: '100.0000000',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };
    const claimableBalancesByClaimant = {
      [mine.stealthAddress]: [
        {
          id: CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: 'GSENDERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };

    const horizon = new HorizonClient(
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx, claimableBalancesByClaimant }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);
    const { payments } = await adapter.scan(keys);

    // Only the token claimable balance surfaces; the native funding leg is gone.
    expect(payments).toHaveLength(1);
    const token = payments.find((p) => p.claimableBalanceId);
    expect(token).toBeDefined();
    expect(token!.amount).toBe(100);
    expect(token!.asset).toBe(ASSET);
    expect(payments.some((p) => p.token === 'native')).toBe(false);
  });

  it('discovers a genuine 1.5001 XLM native send (no CB) — not misclassified as a stub', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_1_5001',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    // A genuine native send of EXACTLY 1.5001 XLM with NO claimable balance in
    // the tx. The old amount-based heuristic suppressed this; the fixed
    // CB-presence gate must surface it as real native income.
    const operationsByTx = {
      HASH_1_5001: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_1_5001',
          account: mine.stealthAddress,
          starting_balance: '1.5001000',
        },
      ],
    };

    const horizon = new HorizonClient(
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);
    const { payments } = await adapter.scan(keys);

    expect(payments).toHaveLength(1);
    expect(payments[0]!.token).toBe('native');
    expect(payments[0]!.amount).toBe(1.5001);
    expect(payments[0]!.amountStroops).toBe('15001000');
  });

  it('suppresses a merged/claimed native account when suppressClaimedNative is set', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveStealthAddressWithSecret(
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
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    const operationsByTx = {
      HASH_MERGED: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_MERGED',
          account: mine.stealthAddress,
          starting_balance: '42.0000000',
        },
      ],
    };
    // The account still exists but its native balance is 0 (swept/merged).
    const accountsByAddress = {
      [mine.stealthAddress]: {
        id: mine.stealthAddress,
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '0.0000000' }],
      },
    };

    const horizon = new HorizonClient(
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx, accountsByAddress }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);

    // Without suppression the op amount surfaces (default hot path, no probe).
    const plain = await adapter.scan(keys);
    expect(plain.payments).toHaveLength(1);
    expect(plain.payments[0]!.amount).toBe(42);

    // With suppression the swept account is dropped.
    const suppressed = await adapter.scan(keys, undefined, {
      suppressClaimedNative: true,
    });
    expect(suppressed.payments).toHaveLength(0);
  });

  it('falls back to op amount when suppression probe finds no live account', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
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
    ];
    const operationsByTx = {
      HASH_MINE: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_MINE',
          account: mine.stealthAddress,
          starting_balance: '42.0000000',
        },
      ],
    };

    // No accountsByAddress -> getAccount returns null (404). Suppression must
    // NOT drop the payment on an unknown/absent account: fall back to op amount.
    const horizon = new HorizonClient(
      'https://horizon.mock',
      makeStubFetch({ transactions, operationsByTx }),
    );
    const adapter = new AccountAdapter(Networks.TESTNET, horizon);

    const { payments } = await adapter.scan(keys, undefined, {
      suppressClaimedNative: true,
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe(42);
  });
});
