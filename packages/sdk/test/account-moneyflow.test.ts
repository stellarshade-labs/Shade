import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import { Networks, encodeMuxedAccount, encodeMuxedAccountToAddress } from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import { HorizonClient, type FetchLike } from '../src/horizon.js';
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

function deriveMine(raw: ReturnType<typeof generateMetaAddress>) {
  return deriveStealthAddressWithSecret(
    raw.metaAddress.spendPubKey,
    raw.metaAddress.viewPubKey,
    new Uint8Array(randomBytes(32)),
  );
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
      if (!account) return { ok: false, status: 404, json: async () => ({}) };
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

const ASSET = 'USDC:GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const SENDER = 'GSENDERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const ATTACKER = 'GATTACKERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const REAL_CB_ID =
  '00000000aaaaaaaa0000000000000000000000000000000000000000000000aa';
const ATTACKER_CB_ID =
  '00000000bbbbbbbb0000000000000000000000000000000000000000000000bb';

describe('Fix #1: attacker CB cannot mask the real token payment', () => {
  it('binds the CB by sponsor+asset+amount, not by first-claimant', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveMine(raw);

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_TOKEN',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
        source_account: SENDER,
      },
    ];
    const operationsByTx = {
      HASH_TOKEN: [
        {
          id: 'o0',
          type: 'create_account',
          transaction_hash: 'HASH_TOKEN',
          account: mine.stealthAddress,
          starting_balance: '1.5001000',
        },
        {
          id: 'o1',
          type: 'create_claimable_balance',
          transaction_hash: 'HASH_TOKEN',
          asset: ASSET,
          amount: '100.0000000',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };
    // Horizon returns the ATTACKER's decoy CB FIRST — an attacker created their
    // own CreateClaimableBalance naming the public stealth address with a wrong
    // amount. The old first-claimant lookup would have picked this one.
    const claimableBalancesByClaimant = {
      [mine.stealthAddress]: [
        {
          id: ATTACKER_CB_ID,
          asset: ASSET,
          amount: '0.0000001',
          sponsor: ATTACKER,
          claimants: [{ destination: mine.stealthAddress }],
        },
        {
          id: REAL_CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: SENDER,
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };

    const horizon = new HorizonClient(
      'http://localhost:8000',
      makeStubFetch({ transactions, operationsByTx, claimableBalancesByClaimant }),
    );
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);
    const { payments } = await adapter.scan(keys);

    expect(payments).toHaveLength(1);
    const token = payments[0]!;
    // The GENUINE payment is reported: real id, amount, asset — not the decoy.
    expect(token.claimableBalanceId).toBe(REAL_CB_ID);
    expect(token.amount).toBe(100);
    expect(token.amountStroops).toBe('1000000000');
    expect(token.asset).toBe(ASSET);
  });
});

describe('Fix #3: balance reports live remaining after a partial claim', () => {
  it('reports ~49 after a partial claim of an original 100 XLM; drops a fully-swept account', async () => {
    const { keys, raw } = keysToHex();
    const partial = deriveMine(raw);
    const swept = deriveMine(raw);

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_PARTIAL',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(partial.ephemeralPubKey).toString('base64'),
        successful: true,
      },
      {
        id: 't2',
        hash: 'HASH_SWEPT',
        paging_token: '2',
        memo_type: 'hash',
        memo: Buffer.from(swept.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    const operationsByTx = {
      HASH_PARTIAL: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_PARTIAL',
          account: partial.stealthAddress,
          starting_balance: '100.0000000',
        },
      ],
      HASH_SWEPT: [
        {
          id: 'o2',
          type: 'create_account',
          transaction_hash: 'HASH_SWEPT',
          account: swept.stealthAddress,
          starting_balance: '100.0000000',
        },
      ],
    };
    const accountsByAddress = {
      [partial.stealthAddress]: {
        id: partial.stealthAddress,
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '49.0000000' }],
      },
      [swept.stealthAddress]: {
        id: swept.stealthAddress,
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '0.0000000' }],
      },
    };

    const horizon = new HorizonClient(
      'http://localhost:8000',
      makeStubFetch({ transactions, operationsByTx, accountsByAddress }),
    );
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);

    // Discovery scan (no suppression): reports the original per-tx op amount.
    const discovery = await adapter.scan(keys);
    const discPartial = discovery.payments.find(
      (p) => p.stealthAddress === partial.stealthAddress,
    );
    expect(discPartial!.amount).toBe(100);

    // Balance path (suppression): reports the LIVE remaining balance.
    const balanced = await adapter.scan(keys, undefined, {
      suppressClaimedNative: true,
    });
    const balPartial = balanced.payments.find(
      (p) => p.stealthAddress === partial.stealthAddress,
    );
    expect(balPartial).toBeDefined();
    expect(balPartial!.amount).toBe(49);
    expect(balPartial!.amountStroops).toBe('490000000');
    // Fully-swept account is dropped entirely.
    expect(
      balanced.payments.some((p) => p.stealthAddress === swept.stealthAddress),
    ).toBe(false);
  });

  it('client.balance() reports ~49, not 100, after a partial claim', async () => {
    const { keys, raw } = keysToHex();
    const partial = deriveMine(raw);

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_PARTIAL',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(partial.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    const operationsByTx: Record<string, unknown[]> = {
      HASH_PARTIAL: [
        {
          id: 'o1',
          type: 'create_account',
          transaction_hash: 'HASH_PARTIAL',
          account: partial.stealthAddress,
          starting_balance: '100.0000000',
        },
      ],
    };
    const accountsByAddress: Record<string, unknown> = {
      [partial.stealthAddress]: {
        id: partial.stealthAddress,
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '49.0000000' }],
      },
    };

    const stub = makeStubFetch({ transactions, operationsByTx, accountsByAddress });
    vi.stubGlobal('fetch', stub);

    const client = new StealthClient({
      network: 'local',
      methods: ['account'],
      horizonUrl: 'http://localhost:8000',
    });
    const balances = await client.balance(keys);

    const row = balances.find((b) => b.stealthAddress === partial.stealthAddress);
    expect(row).toBeDefined();
    expect(row!.amount).toBe(49);
    expect(row!.amountStroops).toBe('490000000');
  });
});

describe('Fix #5: CB predicates and muxed destinations', () => {
  it('does not report a CB with an unsatisfiable (already-expired) predicate', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveMine(raw);

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_EXPIRED',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
        source_account: SENDER,
      },
    ];
    const operationsByTx = {
      HASH_EXPIRED: [
        {
          id: 'o1',
          type: 'create_claimable_balance',
          transaction_hash: 'HASH_EXPIRED',
          asset: ASSET,
          amount: '100.0000000',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };
    // The live CB's predicate for our address is abs_before an epoch already in
    // the past -> not claimable NOW -> must not be reported as income.
    const pastEpoch = String(Math.floor(Date.now() / 1000) - 3600);
    const claimableBalancesByClaimant = {
      [mine.stealthAddress]: [
        {
          id: REAL_CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: SENDER,
          claimants: [
            {
              destination: mine.stealthAddress,
              predicate: { abs_before_epoch: pastEpoch },
            },
          ],
        },
      ],
    };

    const horizon = new HorizonClient(
      'http://localhost:8000',
      makeStubFetch({ transactions, operationsByTx, claimableBalancesByClaimant }),
    );
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);
    const { payments } = await adapter.scan(keys);
    expect(payments).toHaveLength(0);
  });

  it('reports a CB whose abs_before predicate is still in the future', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveMine(raw);

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_FUTURE',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
        source_account: SENDER,
      },
    ];
    const operationsByTx = {
      HASH_FUTURE: [
        {
          id: 'o1',
          type: 'create_claimable_balance',
          transaction_hash: 'HASH_FUTURE',
          asset: ASSET,
          amount: '100.0000000',
          claimants: [{ destination: mine.stealthAddress }],
        },
      ],
    };
    const futureEpoch = String(Math.floor(Date.now() / 1000) + 3600);
    const claimableBalancesByClaimant = {
      [mine.stealthAddress]: [
        {
          id: REAL_CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: SENDER,
          claimants: [
            {
              destination: mine.stealthAddress,
              predicate: { abs_before_epoch: futureEpoch },
            },
          ],
        },
      ],
    };

    const horizon = new HorizonClient(
      'http://localhost:8000',
      makeStubFetch({ transactions, operationsByTx, claimableBalancesByClaimant }),
    );
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);
    const { payments } = await adapter.scan(keys);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.claimableBalanceId).toBe(REAL_CB_ID);
  });

  it('discovers a payment addressed to the muxed (M...) form of the stealth address', async () => {
    const { keys, raw } = keysToHex();
    const mine = deriveMine(raw);
    const muxed = encodeMuxedAccountToAddress(
      encodeMuxedAccount(mine.stealthAddress, '42'),
    );
    expect(muxed.startsWith('M')).toBe(true);

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_MUXED',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
      },
    ];
    // The payment op names the MUXED form of the stealth address as its `to`.
    const operationsByTx = {
      HASH_MUXED: [
        {
          id: 'o1',
          type: 'payment',
          transaction_hash: 'HASH_MUXED',
          to: muxed,
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
    expect(payments[0]!.stealthAddress).toBe(mine.stealthAddress);
    expect(payments[0]!.amount).toBe(7.5);
  });
});
