import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { Keypair } from '@stellar/stellar-sdk';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import type { StealthKeys } from '@shade/sdk';
import { collectAccountBalances } from '../src/commands/balance.js';

/** Minimal PersistedPayment shape for the in-memory cache rows. */
interface CachedRow {
  stealthAddress: string;
  ephemeralPubKey: string;
  token: string;
  asset?: string;
  claimableBalanceId?: string;
  amount: number;
  amountStroops: string;
  txHash?: string;
}

// In-memory replacement for ~/.stealth cursor/payment persistence, so the
// test never touches the real home directory.
const store = vi.hoisted(() => ({
  cursor: undefined as string | undefined,
  savedCursors: [] as string[],
  payments: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/utils/config.js', () => ({
  getContractAddress: () => 'CCONTRACT_UNUSED_IN_THIS_TEST',
  saveContractAddress: () => {},
  loadHorizonCursor: () => store.cursor,
  saveHorizonCursor: (_network: string, cursor: string) => {
    store.savedCursors.push(cursor);
    store.cursor = cursor;
  },
  clearHorizonCursor: () => {
    store.cursor = undefined;
  },
  loadHorizonPayments: () => [...store.payments],
  saveHorizonPayments: (_network: string, payments: Array<Record<string, unknown>>) => {
    // Append semantics are enough here; the helper's own dedupe must cope
    // with the fresh rows reappearing in the subsequent load.
    store.payments.push(...payments);
  },
  clearHorizonPayments: () => {
    store.payments = [];
  },
  findHorizonPayment: () => undefined,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  store.cursor = undefined;
  store.savedCursors = [];
  store.payments = [];
});

describe('shade balance account phase (cursor reuse + cache union)', () => {
  it('resumes from the persisted cursor, saves the advanced one, and unions live cached rows without double-counting', async () => {
    const raw = generateMetaAddress();
    const keys: StealthKeys = {
      metaAddress: encodeMetaAddress(raw.metaAddress),
      spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
    };

    // A NEW payment past the persisted cursor, discovered by the fresh scan.
    const fresh = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const liveNativeAddr = Keypair.random().publicKey();
    const mergedNativeAddr = Keypair.random().publicKey();
    const liveCbAddr = Keypair.random().publicKey();
    const claimedCbAddr = Keypair.random().publicKey();
    const usdc = `USDC:${Keypair.random().publicKey()}`;

    store.cursor = '100';
    const cachedRows: CachedRow[] = [
      // Live native: account probe returns 5 XLM -> included at live value.
      {
        stealthAddress: liveNativeAddr,
        ephemeralPubKey: 'aa'.repeat(32),
        token: 'native',
        amount: 5,
        amountStroops: '50000000',
        txHash: 'TX_CACHED_LIVE',
      },
      // Merged native: account probe 404s -> dropped.
      {
        stealthAddress: mergedNativeAddr,
        ephemeralPubKey: 'bb'.repeat(32),
        token: 'native',
        amount: 9,
        amountStroops: '90000000',
        txHash: 'TX_CACHED_MERGED',
      },
      // Live claimable balance -> included at the CB's live amount.
      {
        stealthAddress: liveCbAddr,
        ephemeralPubKey: 'cc'.repeat(32),
        token: usdc,
        asset: usdc,
        claimableBalanceId: 'CBLIVE',
        amount: 3,
        amountStroops: '30000000',
        txHash: 'TX_CB_LIVE',
      },
      // Already-claimed claimable balance (gone from Horizon) -> dropped.
      {
        stealthAddress: claimedCbAddr,
        ephemeralPubKey: 'dd'.repeat(32),
        token: usdc,
        asset: usdc,
        claimableBalanceId: 'CBGONE',
        amount: 8,
        amountStroops: '80000000',
        txHash: 'TX_CB_GONE',
      },
      // Same address as the FRESH find, different tx: the live balance is
      // already reported by the fresh row -> must NOT be counted again.
      {
        stealthAddress: fresh.stealthAddress,
        ephemeralPubKey: 'ee'.repeat(32),
        token: 'native',
        amount: 1,
        amountStroops: '10000000',
        txHash: 'TX_DUP',
      },
    ];
    store.payments = [...cachedRows] as unknown as Array<Record<string, unknown>>;

    const urls: string[] = [];
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.includes('/claimable_balances?claimant=')) {
        const claimant = decodeURIComponent(
          url.split('claimant=')[1]!.split('&')[0]!,
        );
        const records =
          claimant === liveCbAddr
            ? [
                {
                  id: 'CBLIVE',
                  asset: usdc,
                  amount: '3.0000000',
                  claimants: [{ destination: liveCbAddr }],
                },
              ]
            : [];
        return ok({ _embedded: { records } });
      }
      if (url.includes('/accounts/')) {
        const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
        const balances: Record<string, string> = {
          [liveNativeAddr]: '5.0000000',
          [fresh.stealthAddress]: '17.0000000',
        };
        const bal = balances[address];
        if (!bal) return notFound();
        return ok({
          id: address,
          sequence: '1',
          balances: [{ asset_type: 'native', balance: bal }],
        });
      }
      if (url.includes('/transactions/') && url.includes('/operations')) {
        return ok({
          _embedded: {
            records: [
              {
                id: 'op1',
                type: 'create_account',
                transaction_hash: 'HASH_FRESH',
                account: fresh.stealthAddress,
                starting_balance: '17.0000000',
              },
            ],
          },
        });
      }
      if (url.includes('/transactions?')) {
        // One short page: the tx right after the persisted cursor.
        return ok({
          _embedded: {
            records: [
              {
                id: 't1',
                hash: 'HASH_FRESH',
                paging_token: '101',
                memo_type: 'hash',
                memo: Buffer.from(fresh.ephemeralPubKey).toString('base64'),
                successful: true,
              },
            ],
          },
        });
      }
      return notFound();
    });

    const rows = await collectAccountBalances('testnet', keys);

    // The persisted cursor was forwarded into the Horizon walk (no full
    // re-walk of history) and the advanced cursor was saved back.
    const txPages = urls.filter((u) => u.includes('/transactions?'));
    expect(txPages).toHaveLength(1);
    expect(txPages[0]).toContain('cursor=100');
    expect(store.savedCursors).toEqual(['101']);

    // The fresh find was persisted to the payments cache (a cursor-advanced
    // scan must never strand a payment outside the cache).
    expect(
      store.payments.some(
        (p) =>
          p.txHash === 'HASH_FRESH' &&
          p.stealthAddress === fresh.stealthAddress &&
          typeof p.ephemeralPubKey === 'string',
      ),
    ).toBe(true);

    // Union rows: fresh live + cached live native + cached live CB. The
    // merged account, the claimed CB, and the duplicate row are all absent.
    expect(rows).toHaveLength(3);
    const byAddr = new Map(rows.map((r) => [r.stealthAddress, r]));
    expect(byAddr.get(fresh.stealthAddress)).toMatchObject({
      token: 'native',
      stroops: 170000000n,
    });
    expect(byAddr.get(liveNativeAddr)).toMatchObject({
      token: 'native',
      stroops: 50000000n,
    });
    expect(byAddr.get(liveCbAddr)).toMatchObject({
      token: usdc,
      stroops: 30000000n,
    });
    expect(byAddr.has(mergedNativeAddr)).toBe(false);
    expect(byAddr.has(claimedCbAddr)).toBe(false);
  });

  it('first run (no persisted cursor) scans from the beginning and still works', async () => {
    const raw = generateMetaAddress();
    const keys: StealthKeys = {
      metaAddress: encodeMetaAddress(raw.metaAddress),
      spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
    };
    const fresh = deriveStealthAddressWithSecret(
      raw.metaAddress.spendPubKey,
      raw.metaAddress.viewPubKey,
      new Uint8Array(randomBytes(32)),
    );

    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.includes('/accounts/')) {
        const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
        if (address !== fresh.stealthAddress) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: address,
            sequence: '1',
            balances: [{ asset_type: 'native', balance: '17.0000000' }],
          }),
        };
      }
      if (url.includes('/transactions/') && url.includes('/operations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: {
              records: [
                {
                  id: 'op1',
                  type: 'create_account',
                  transaction_hash: 'HASH_FRESH',
                  account: fresh.stealthAddress,
                  starting_balance: '17.0000000',
                },
              ],
            },
          }),
        };
      }
      if (url.includes('/transactions?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: {
              records: [
                {
                  id: 't1',
                  hash: 'HASH_FRESH',
                  paging_token: '7',
                  memo_type: 'hash',
                  memo: Buffer.from(fresh.ephemeralPubKey).toString('base64'),
                  successful: true,
                },
              ],
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const rows = await collectAccountBalances('testnet', keys);

    // No cursor parameter on the first page, cursor persisted afterwards.
    expect(urls.find((u) => u.includes('/transactions?'))).not.toContain(
      'cursor=',
    );
    expect(store.savedCursors).toEqual(['7']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stealthAddress: fresh.stealthAddress,
      token: 'native',
      stroops: 170000000n,
    });
  });
});
