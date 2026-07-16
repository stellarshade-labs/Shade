import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import { Networks } from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import {
  HorizonClient,
  type FetchLike,
  type HorizonClaimableBalance,
} from '../src/horizon.js';
import type { StealthKeys } from '../src/types.js';

const PAGE = 200;

/** A synthetic claimable-balance record. */
function cb(
  id: string,
  claimant: string,
  overrides: Partial<HorizonClaimableBalance> = {},
): HorizonClaimableBalance {
  return {
    id,
    asset: 'SPAM:GATTACKERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: '0.0000001',
    claimants: [{ destination: claimant }],
    ...overrides,
  };
}

/** Extract the `cursor` query param from a request URL (undefined if absent). */
function cursorOf(url: string): string | undefined {
  return new URL(url).searchParams.get('cursor') ?? undefined;
}

describe('HorizonClient.getClaimableBalances paging (SDK-CBPAGE)', () => {
  const CLAIMANT = 'G'.padEnd(56, 'A');

  it('follows the paging_token cursor through every page and accumulates all records', async () => {
    // Page 1: a full page of 200 spam records; page 2: the genuine one.
    const page1 = Array.from({ length: PAGE }, (_, i) =>
      cb(`spam-${i}`, CLAIMANT, { paging_token: `pt-${i}` }),
    );
    const page2 = [
      cb('genuine', CLAIMANT, {
        asset: 'USDC:GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '100.0000000',
        paging_token: 'pt-genuine',
      }),
    ];

    const requests: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      const cursor = cursorOf(url);
      const records =
        cursor === undefined ? page1 : cursor === 'pt-199' ? page2 : [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records } }),
      };
    };

    const horizon = new HorizonClient('http://localhost:8000', fetchFn);
    const all = await horizon.getClaimableBalances(CLAIMANT);

    // Every record from every page, in order — the genuine one is NOT lost.
    expect(all).toHaveLength(PAGE + 1);
    expect(all[0]!.id).toBe('spam-0');
    expect(all[PAGE]!.id).toBe('genuine');

    // Exactly two requests: page 1 without a cursor, page 2 resumed from the
    // last record's paging_token.
    expect(requests).toHaveLength(2);
    expect(cursorOf(requests[0]!)).toBeUndefined();
    expect(cursorOf(requests[1]!)).toBe('pt-199');
    expect(requests[1]!).toContain(`claimant=${CLAIMANT}`);
  });

  it('falls back to the _links.next.href cursor when records carry no paging_token', async () => {
    const page1 = Array.from({ length: PAGE }, (_, i) => cb(`a-${i}`, CLAIMANT));
    const page2 = [cb('tail', CLAIMANT)];

    const requests: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      const cursor = cursorOf(url);
      if (cursor === undefined) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _links: {
              next: {
                href:
                  'http://localhost:8000/claimable_balances' +
                  `?claimant=${CLAIMANT}&cursor=NEXT123&limit=200`,
              },
            },
            _embedded: { records: page1 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records: cursor === 'NEXT123' ? page2 : [] } }),
      };
    };

    const horizon = new HorizonClient('http://localhost:8000', fetchFn);
    const all = await horizon.getClaimableBalances(CLAIMANT);

    expect(all).toHaveLength(PAGE + 1);
    expect(requests).toHaveLength(2);
    expect(cursorOf(requests[1]!)).toBe('NEXT123');
  });

  it('stops after a full page when no cursor can be derived (no infinite loop)', async () => {
    // A pathological Horizon: full page, but no paging_token and no next link.
    const page1 = Array.from({ length: PAGE }, (_, i) => cb(`x-${i}`, CLAIMANT));
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records: page1 } }),
      };
    };

    const horizon = new HorizonClient('http://localhost:8000', fetchFn);
    const all = await horizon.getClaimableBalances(CLAIMANT);

    expect(all).toHaveLength(PAGE);
    expect(calls).toBe(1);
  });

  it('is defensively bounded: an endless stream of full pages stops at the page cap', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      const k = calls++;
      const records = Array.from({ length: PAGE }, (_, i) =>
        cb(`p${k}-${i}`, CLAIMANT, { paging_token: `pt-${k}-${i}` }),
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records } }),
      };
    };

    const horizon = new HorizonClient('http://localhost:8000', fetchFn);
    const all = await horizon.getClaimableBalances(CLAIMANT);

    // 50-page defensive cap (10,000 records) — bounded, not infinite.
    expect(calls).toBe(50);
    expect(all).toHaveLength(50 * PAGE);
  });
});

describe('account scan: genuine CB pushed past page 1 by claimant spam', () => {
  it('still binds the real token payment when 200 attacker CBs precede it', async () => {
    const raw = generateMetaAddress();
    const keys: StealthKeys = {
      metaAddress: encodeMetaAddress(raw.metaAddress),
      spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
    };
    const mine = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const ASSET = 'USDC:GISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const SENDER = 'GSENDERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const GENUINE_ID =
      '00000000abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

    const transactions = [
      {
        id: 't1',
        hash: 'HASH_CB',
        paging_token: '1',
        memo_type: 'hash',
        memo: Buffer.from(mine.ephemeralPubKey).toString('base64'),
        successful: true,
        source_account: SENDER,
      },
    ];
    const operationsByTx: Record<string, unknown[]> = {
      HASH_CB: [
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

    // The attack: 200 cheap CBs naming OUR stealth address fill page 1; the
    // genuine payment is on page 2. A single-page fetch would miss it.
    const spamPage = Array.from({ length: PAGE }, (_, i) =>
      cb(`spam-${i}`, mine.stealthAddress, { paging_token: `pt-${i}` }),
    );
    const genuinePage = [
      cb(GENUINE_ID, mine.stealthAddress, {
        asset: ASSET,
        amount: '100.0000000',
        sponsor: SENDER,
        paging_token: 'pt-genuine',
      }),
    ];

    const fetchFn: FetchLike = async (url: string) => {
      if (url.includes('/claimable_balances?claimant=')) {
        const cursor = cursorOf(url);
        const records =
          cursor === undefined ? spamPage : cursor === 'pt-199' ? genuinePage : [];
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { records } }),
        };
      }
      if (url.includes('/transactions/') && url.includes('/operations')) {
        const hashKey = url.split('/transactions/')[1]!.split('/operations')[0]!;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: { records: operationsByTx[hashKey] ?? [] },
          }),
        };
      }
      if (url.includes('/transactions?')) {
        const hasCursor = url.includes('cursor=');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: { records: hasCursor ? [] : transactions },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const horizon = new HorizonClient('http://localhost:8000', fetchFn);
    const adapter = new AccountAdapter(Networks.STANDALONE, horizon);
    const { payments } = await adapter.scan(keys);

    expect(payments).toHaveLength(1);
    expect(payments[0]!.claimableBalanceId).toBe(GENUINE_ID);
    expect(payments[0]!.asset).toBe(ASSET);
    expect(payments[0]!.amount).toBe(100);
  });
});
