import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import { Networks, Keypair } from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import { StealthClient } from '../src/client.js';
import { HorizonClient, type FetchLike, type HorizonOp } from '../src/horizon.js';
import { IndexerClient, type IndexerAnnouncement } from '../src/indexer.js';
import type { StealthKeys, Payment, MethodScanMeta } from '../src/types.js';

const HORIZON = 'https://horizon.mock';
const INDEXER = 'https://indexer.mock';
const NET = Networks.TESTNET;
const SENDER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ASSET = `USDC:${ISSUER}`;
const CB_ID =
  '00000000abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

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

/** One on-chain tx fixture: the Horizon transaction record + its operations. */
interface Fixture {
  tx: {
    id: string;
    hash: string;
    paging_token: string;
    memo_type: string;
    memo?: string;
    successful?: boolean;
    source_account?: string;
  };
  ops: HorizonOp[];
  stealthAddress?: string;
}

/** A native send to OUR meta-address at the given feed position. */
function mineNativeTx(
  raw: ReturnType<typeof generateMetaAddress>,
  token: string,
  amount: string,
): Fixture {
  const stealth = deriveStealthAddressWithSecret(
    raw.metaAddress.spendPubKey,
    raw.metaAddress.viewPubKey,
    new Uint8Array(randomBytes(32)),
  );
  const hash = `HASH_${token}`;
  return {
    tx: {
      id: hash,
      hash,
      paging_token: token,
      memo_type: 'hash',
      memo: Buffer.from(stealth.ephemeralPubKey).toString('base64'),
      successful: true,
    },
    ops: [
      {
        id: `op_${token}`,
        type: 'create_account',
        transaction_hash: hash,
        account: stealth.stealthAddress,
        starting_balance: amount,
      },
    ],
    stealthAddress: stealth.stealthAddress,
  };
}

/** A token send (funding stub + claimable balance) to OUR meta-address. */
function mineTokenTx(
  raw: ReturnType<typeof generateMetaAddress>,
  token: string,
): Fixture {
  const stealth = deriveStealthAddressWithSecret(
    raw.metaAddress.spendPubKey,
    raw.metaAddress.viewPubKey,
    new Uint8Array(randomBytes(32)),
  );
  const hash = `HASH_${token}`;
  return {
    tx: {
      id: hash,
      hash,
      paging_token: token,
      memo_type: 'hash',
      memo: Buffer.from(stealth.ephemeralPubKey).toString('base64'),
      successful: true,
      source_account: SENDER,
    },
    ops: [
      {
        id: `op_${token}_0`,
        type: 'create_account',
        transaction_hash: hash,
        account: stealth.stealthAddress,
        starting_balance: '1.5001000',
      },
      {
        id: `op_${token}_1`,
        type: 'create_claimable_balance',
        transaction_hash: hash,
        asset: ASSET,
        amount: '100.0000000',
        claimants: [{ destination: stealth.stealthAddress }],
      },
    ],
    stealthAddress: stealth.stealthAddress,
  };
}

/** A hash-memo tx for a DIFFERENT (random) recipient — a scan decoy. */
function decoyTx(token: string): Fixture {
  const hash = `DECOY_${token}`;
  return {
    tx: {
      id: hash,
      hash,
      paging_token: token,
      memo_type: 'hash',
      memo: Buffer.from(randomBytes(32)).toString('base64'),
      successful: true,
    },
    ops: [],
  };
}

/** Serve a fixture the way the indexer does: operations inlined VERBATIM. */
function toAnnouncement(f: Fixture): IndexerAnnouncement {
  return {
    hash: f.tx.hash,
    paging_token: f.tx.paging_token,
    memo: f.tx.memo!,
    memo_type: f.tx.memo_type,
    successful: f.tx.successful !== false,
    created_at: '2026-07-17T00:00:00Z',
    source_account: f.tx.source_account,
    operations: f.ops,
  };
}

function healthOk(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'ok',
    network: 'testnet',
    store: 'postgres',
    cursor: '300',
    startCursor: '100',
    lastCloseTime: '2026-07-17T00:00:00Z',
    lagSeconds: 2,
    announcements: 1,
    ingest: { running: true },
    ...over,
  };
}

function maxToken(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

interface IndexerRoute {
  /** /health body, or a behavior marker (transport reject / HTTP 500). */
  health: Record<string, unknown> | 'reject' | 'http500';
  /**
   * Per-call /health bodies overriding `health`: the Nth call gets the Nth
   * entry, later calls repeat the last. Lets a test flip the answer between
   * the pre-scan guard and the post-segment re-check.
   */
  healthSeq?: (Record<string, unknown> | 'reject' | 'http500')[];
  /** Ascending announcement records the /announcements route pages over. */
  announcements?: IndexerAnnouncement[];
  /** Global covered cursor reported on a short /announcements page. */
  cursor?: string;
  /** Fail the Nth (1-based) /announcements call. */
  failAnnouncements?: { call: number; mode: 'http' | 'reject' };
  /** Contract violation: echo the request cursor back unchanged. */
  stallCursor?: boolean;
}

/**
 * One routed injectable fetch serving BOTH hosts (mirroring the account-scan
 * stub for Horizon fixtures and relayer-pool's routedFetch for URL routing +
 * call log). Horizon `/transactions` and indexer `/announcements` both page
 * for real: records strictly after the cursor, capped at the limit — so the
 * bounded-walk and boundary tests exercise genuine paging semantics.
 */
function makeRoutedFetch(opts: {
  horizonTxs: Fixture[];
  claimableBalancesByClaimant?: Record<string, unknown[]>;
  indexer?: IndexerRoute;
}): { fetchFn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let announcementCalls = 0;
  let healthCalls = 0;
  const byHash = new Map(opts.horizonTxs.map((f) => [f.tx.hash, f.ops]));
  const sortedTxs = [...opts.horizonTxs].sort((a, b) =>
    Number(BigInt(a.tx.paging_token) - BigInt(b.tx.paging_token)),
  );

  const fetchFn: FetchLike = async (url) => {
    calls.push(url);

    if (url.startsWith(INDEXER)) {
      const ix = opts.indexer;
      if (!ix) return { ok: false, status: 404, json: async () => ({}) };
      if (url.includes('/health')) {
        healthCalls++;
        const spec =
          ix.healthSeq?.[Math.min(healthCalls, ix.healthSeq.length) - 1] ??
          ix.health;
        if (spec === 'reject') {
          throw new Error('getaddrinfo ENOTFOUND indexer.mock');
        }
        if (spec === 'http500') {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'boom', code: 'boom' }),
          };
        }
        return { ok: true, status: 200, json: async () => spec };
      }
      if (url.includes('/announcements')) {
        announcementCalls++;
        if (ix.failAnnouncements?.call === announcementCalls) {
          if (ix.failAnnouncements.mode === 'reject') {
            throw new Error('socket hang up');
          }
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'ingest stalled', code: 'ingest_stalled' }),
          };
        }
        const u = new URL(url);
        const cursor = u.searchParams.get('cursor');
        const limit = Number(u.searchParams.get('limit') ?? '200');
        const after = cursor ? BigInt(cursor) : -1n;
        const records = (ix.announcements ?? [])
          .filter((a) => BigInt(a.paging_token) > after)
          .slice(0, limit);
        const respCursor = ix.stallCursor
          ? (cursor ?? '0')
          : records.length === limit
            ? records[records.length - 1]!.paging_token
            : maxToken(cursor ?? '0', ix.cursor ?? '0');
        return {
          ok: true,
          status: 200,
          json: async () => ({ records, cursor: respCursor }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
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
        json: async () => ({ _embedded: { records: byHash.get(hash) ?? [] } }),
      };
    }
    if (url.includes('/transactions?')) {
      const u = new URL(url);
      const cursor = u.searchParams.get('cursor');
      const limit = Number(u.searchParams.get('limit') ?? '200');
      // Descending head probe (getLatestTransactionToken): newest first.
      if (u.searchParams.get('order') === 'desc') {
        const records = [...sortedTxs]
          .reverse()
          .slice(0, limit)
          .map((f) => f.tx);
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { records } }),
        };
      }
      const after = cursor ? BigInt(cursor) : -1n;
      const records = sortedTxs
        .filter((f) => BigInt(f.tx.paging_token) > after)
        .slice(0, limit)
        .map((f) => f.tx);
      return {
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records } }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchFn, calls };
}

function makeAdapter(
  fetchFn: FetchLike,
  withIndexer: boolean,
  opts?: { indexerMaxLagSeconds?: number },
): AccountAdapter {
  const horizon = new HorizonClient(HORIZON, fetchFn);
  const indexer = withIndexer ? new IndexerClient(INDEXER, fetchFn) : undefined;
  return new AccountAdapter(NET, horizon, undefined, { indexer, ...opts });
}

/** Count payments per delivering txHash — the no-dup/no-gap assertion tool. */
function countByTxHash(payments: Payment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of payments) {
    counts[p.txHash ?? '?'] = (counts[p.txHash ?? '?'] ?? 0) + 1;
  }
  return counts;
}

/**
 * Horizon /transactions walk URLs in the call log, optionally cursor-less.
 * The descending head probe (getLatestTransactionToken) is not a walk.
 */
function txWalkCalls(calls: string[], onlyGenesis = false): string[] {
  return calls.filter(
    (u) =>
      u.startsWith(HORIZON) &&
      u.includes('/transactions?') &&
      !u.includes('order=desc') &&
      (!onlyGenesis || !u.includes('cursor=')),
  );
}

describe('account scan with indexer', () => {
  it('cold scan: consumes announcements + one Horizon tail page, no genesis walk', async () => {
    const { keys, raw } = keysToHex();
    const old = mineNativeTx(raw, '50', '11.0000000'); // predates coverage
    const covered = mineNativeTx(raw, '200', '42.0000000');
    const decoy = decoyTx('250');
    const tail = mineNativeTx(raw, '350', '7.0000000'); // beyond indexer head

    const { fetchFn, calls } = makeRoutedFetch({
      horizonTxs: [old, covered, decoy, tail],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '300' }),
        announcements: [toAnnouncement(covered), toAnnouncement(decoy)],
        cursor: '300',
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor, meta } = await adapter.scan(keys);

    // The covered payment came from the indexer, the lagging one from the
    // Horizon tail; the pre-coverage payment is skipped by the fast cold
    // start (that is the documented exhaustive tradeoff).
    expect(payments.map((p) => p.txHash).sort()).toEqual(['HASH_200', 'HASH_350']);
    expect(payments.find((p) => p.txHash === 'HASH_200')!.amount).toBe(42);
    expect(payments.find((p) => p.txHash === 'HASH_350')!.amount).toBe(7);
    expect(cursor).toBe('350');

    // Meta mirrors the segmentation exactly: the indexer segment saw the
    // covered payment plus the decoy (both plausible 32-byte-R candidates),
    // the tail saw only the lagging payment. Lag comes from /health verbatim.
    expect(meta).toEqual({
      indexerUsed: true,
      indexerLagSeconds: 2,
      postCheck: 'ok',
      segments: [
        { source: 'indexer', role: 'indexer', candidates: 2, matches: 1 },
        { source: 'horizon', role: 'tail', candidates: 1, matches: 1 },
      ],
    });

    // No global /transactions walk from genesis — the ONLY tx-feed traffic is
    // the single tail page resumed from the indexer's covered cursor.
    expect(txWalkCalls(calls, true)).toEqual([]);
    const walks = txWalkCalls(calls);
    expect(walks).toHaveLength(1);
    expect(walks[0]).toContain('cursor=300');
    expect(calls.some((u) => u.includes('/announcements'))).toBe(true);

    // The indexer-served tx needed NO per-tx operations round-trip; the
    // tail-discovered tx used the normal Horizon operations fetch.
    expect(calls.some((u) => u.includes(`/transactions/${covered.tx.hash}/`))).toBe(false);
    expect(calls.some((u) => u.includes(`/transactions/${tail.tx.hash}/operations`))).toBe(true);
  });

  it('cursor < startCursor: bounded pre-segment, and the tx AT startCursor lands exactly once', async () => {
    const { keys, raw } = keysToHex();
    const pre = mineNativeTx(raw, '50', '2.0000000');
    const boundary = mineNativeTx(raw, '100', '3.0000000'); // AT startCursor
    const covered = mineNativeTx(raw, '200', '4.0000000');
    const tail = mineNativeTx(raw, '300', '5.0000000');

    const { fetchFn, calls } = makeRoutedFetch({
      horizonTxs: [pre, boundary, covered, tail],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '250' }),
        // Coverage is (startCursor, cursor]: the boundary tx is NOT served.
        announcements: [toAnnouncement(covered)],
        cursor: '250',
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor, meta } = await adapter.scan(keys, '10');

    expect(countByTxHash(payments)).toEqual({
      HASH_50: 1,
      HASH_100: 1,
      HASH_200: 1,
      HASH_300: 1,
    });
    expect(cursor).toBe('300');
    // The pre-segment's meta is pinned exactly: it processed the pre-coverage
    // tx AND the boundary tx (candidates and matches both), before the
    // indexer segment and tail counted theirs.
    expect(meta).toEqual({
      indexerUsed: true,
      indexerLagSeconds: 2,
      postCheck: 'ok',
      segments: [
        { source: 'horizon', role: 'pre', candidates: 2, matches: 2 },
        { source: 'indexer', role: 'indexer', candidates: 1, matches: 1 },
        { source: 'horizon', role: 'tail', candidates: 1, matches: 1 },
      ],
    });

    // The boundary tx was processed by the Horizon pre-segment (its ops were
    // fetched exactly once); the covered tx came inline from the indexer.
    const boundaryOps = calls.filter((u) =>
      u.includes(`/transactions/${boundary.tx.hash}/operations`),
    );
    expect(boundaryOps).toHaveLength(1);
    expect(calls.some((u) => u.includes(`/transactions/${covered.tx.hash}/`))).toBe(false);
    // And nothing walked from genesis: the pre-segment resumed at the cursor.
    expect(txWalkCalls(calls, true)).toEqual([]);
  });

  /**
   * A FULL indexer page worth of covered fixtures (200 records, tokens
   * 101..300), with genuine payments at 150 and 250 among the decoys.
   */
  function coveredSpan(raw: ReturnType<typeof generateMetaAddress>): Fixture[] {
    const covered: Fixture[] = [];
    for (let t = 101; t <= 300; t++) {
      if (t === 150) covered.push(mineNativeTx(raw, '150', '5.0000000'));
      else if (t === 250) covered.push(mineNativeTx(raw, '250', '6.0000000'));
      else covered.push(decoyTx(String(t)));
    }
    return covered;
  }

  it('mid-segment indexer 500: Horizon tail resumes from the last adopted cursor — no dup, no gap', async () => {
    const { keys, raw } = keysToHex();
    // The full first page makes the segment loop request a second page —
    // which then fails.
    const covered = coveredSpan(raw);
    const tail = mineNativeTx(raw, '400', '8.0000000');

    const { fetchFn, calls } = makeRoutedFetch({
      horizonTxs: [...covered, tail],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '390' }),
        announcements: covered.map(toAnnouncement),
        cursor: '390',
        failAnnouncements: { call: 2, mode: 'http' },
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor } = await adapter.scan(keys);

    // Page 1 (tokens 101..300) was processed and its cursor (300) adopted
    // BEFORE the failure, so the tail resumes at 300: the two covered
    // payments are not re-discovered (no dup) and the one beyond the adopted
    // cursor is (no gap).
    expect(countByTxHash(payments)).toEqual({
      HASH_150: 1,
      HASH_250: 1,
      HASH_400: 1,
    });
    expect(cursor).toBe('400');

    expect(txWalkCalls(calls, true)).toEqual([]);
    const walks = txWalkCalls(calls);
    expect(walks).toHaveLength(1);
    expect(walks[0]).toContain('cursor=300');
    // Indexer-served payments needed no per-tx operations fetch.
    expect(calls.some((u) => u.includes('/transactions/HASH_150/'))).toBe(false);
    expect(calls.some((u) => u.includes('/transactions/HASH_250/'))).toBe(false);
  });

  it('a stalled full-page cursor cannot loop or gap: last record token is adopted', async () => {
    const { keys, raw } = keysToHex();
    const covered = coveredSpan(raw);
    const tail = mineNativeTx(raw, '400', '8.0000000');

    const { fetchFn, calls } = makeRoutedFetch({
      horizonTxs: [...covered, tail],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '390' }),
        announcements: covered.map(toAnnouncement),
        cursor: '390',
        // Contract violation: every page echoes the request cursor back.
        stallCursor: true,
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor } = await adapter.scan(keys);

    // The scan terminated (no infinite replay of the stalled full page), the
    // processed records were not re-walked by the tail (no dup — the last
    // record's token stood in for the broken cursor), and the payment beyond
    // it was still found (no gap).
    expect(countByTxHash(payments)).toEqual({
      HASH_150: 1,
      HASH_250: 1,
      HASH_400: 1,
    });
    expect(cursor).toBe('400');
    const walks = txWalkCalls(calls);
    expect(walks).toHaveLength(1);
    expect(walks[0]).toContain('cursor=300');
  });

  it('first-call indexer network error: tail covers the whole span from startCursor', async () => {
    const { keys, raw } = keysToHex();
    const covered = mineNativeTx(raw, '200', '4.0000000');
    const tail = mineNativeTx(raw, '300', '5.0000000');

    const { fetchFn, calls } = makeRoutedFetch({
      horizonTxs: [covered, tail],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '250' }),
        announcements: [toAnnouncement(covered)],
        cursor: '250',
        failAnnouncements: { call: 1, mode: 'reject' },
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor } = await adapter.scan(keys);

    // Nothing was adopted from the indexer, so the tail starts at startCursor
    // and discovers BOTH payments via plain Horizon — exactly once each.
    expect(countByTxHash(payments)).toEqual({ HASH_200: 1, HASH_300: 1 });
    expect(cursor).toBe('300');
    const walks = txWalkCalls(calls);
    expect(walks).toHaveLength(1);
    expect(walks[0]).toContain('cursor=100');
    expect(calls.some((u) => u.includes(`/transactions/${covered.tx.hash}/operations`))).toBe(true);
  });

  it('health guard failures fall back to pure Horizon, identical to no-indexer', async () => {
    const { keys, raw } = keysToHex();
    const early = mineNativeTx(raw, '50', '2.0000000');
    const late = mineNativeTx(raw, '200', '4.0000000');
    const horizonTxs = [early, decoyTx('120'), late];

    // Baseline: the same fixtures scanned with NO indexer configured.
    const base = makeRoutedFetch({ horizonTxs });
    const baseline = await makeAdapter(base.fetchFn, false).scan(keys);
    expect(baseline.payments).toHaveLength(2);

    const variants: Array<
      [string, IndexerRoute['health'], MethodScanMeta['indexerSkipReason']]
    > = [
      ['status not ok', healthOk({ status: 'starting' }), 'unhealthy'],
      ['network mismatch', healthOk({ network: 'public' }), 'network_mismatch'],
      ['null cursor', healthOk({ cursor: null }), 'no_coverage'],
      ['null startCursor', healthOk({ startCursor: null }), 'no_coverage'],
      ['health 5xx', 'http500', 'unreachable'],
      ['health unreachable', 'reject', 'unreachable'],
      // Lag beyond the DEFAULT 6h cap: skipped as operationally abandoned.
      ['stale lag', healthOk({ lagSeconds: 999_999 }), 'stale'],
    ];
    for (const [label, health, reason] of variants) {
      const { fetchFn, calls } = makeRoutedFetch({
        horizonTxs,
        indexer: { health, announcements: [toAnnouncement(late)], cursor: '250' },
      });
      const result = await makeAdapter(fetchFn, true).scan(keys);

      expect(result.payments, label).toEqual(baseline.payments);
      expect(result.cursor, label).toBe(baseline.cursor);
      // The guarded run never touched /announcements and DID walk from
      // genesis, exactly like the no-indexer scan.
      expect(calls.some((u) => u.includes('/announcements')), label).toBe(false);
      expect(txWalkCalls(calls, true), label).toHaveLength(1);
      // Meta names the guard that fired and reports the single full walk
      // (candidates: both payments + the decoy; matches: the two payments).
      expect(result.meta.indexerUsed, label).toBe(false);
      expect(result.meta.indexerSkipReason, label).toBe(reason);
      expect(result.meta.segments, label).toEqual([
        { source: 'horizon', role: 'full', candidates: 3, matches: 2 },
      ]);
      if (reason === 'stale') {
        // Only the stale guard has read a numeric lag by the time it fires.
        expect(result.meta.indexerLagSeconds, label).toBe(999_999);
      }
    }
  });

  it('the same tx yields deep-equal Payments via Horizon and via indexer inline ops', async () => {
    const { keys, raw } = keysToHex();
    const native = mineNativeTx(raw, '150', '42.0000000');
    const token = mineTokenTx(raw, '160');
    const claimableBalancesByClaimant = {
      [token.stealthAddress!]: [
        {
          id: CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: SENDER,
          claimants: [{ destination: token.stealthAddress }],
        },
      ],
    };

    // Run A: pure Horizon (per-tx operations fetches).
    const a = makeRoutedFetch({
      horizonTxs: [native, token],
      claimableBalancesByClaimant,
    });
    const horizonRun = await makeAdapter(a.fetchFn, false).scan(keys);

    // Run B: both txs served by the indexer with inlined operations.
    const b = makeRoutedFetch({
      horizonTxs: [native, token],
      claimableBalancesByClaimant,
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '200' }),
        announcements: [toAnnouncement(native), toAnnouncement(token)],
        cursor: '200',
      },
    });
    const indexerRun = await makeAdapter(b.fetchFn, true).scan(keys);

    // The rows a claim consumes must be identical whichever path found them.
    expect(indexerRun.payments).toEqual(horizonRun.payments);
    expect(indexerRun.payments).toHaveLength(2);
    const tokenRow = indexerRun.payments.find((p) => p.claimableBalanceId);
    expect(tokenRow).toMatchObject({
      claimableBalanceId: CB_ID,
      asset: ASSET,
      token: ASSET,
      amountStroops: '1000000000',
      stealthAddress: token.stealthAddress,
    });
    const nativeRow = indexerRun.payments.find((p) => p.token === 'native');
    expect(nativeRow).toMatchObject({
      amountStroops: '420000000',
      stealthAddress: native.stealthAddress,
    });
    // Run B fetched no per-tx operations from Horizon.
    expect(b.calls.some((u) => u.includes('/operations'))).toBe(false);
  });

  it('exhaustive: true cold scan runs the genesis pre-segment up to startCursor', async () => {
    const { keys, raw } = keysToHex();
    const old = mineNativeTx(raw, '50', '11.0000000');
    const boundary = mineNativeTx(raw, '100', '3.0000000');
    const covered = mineNativeTx(raw, '200', '4.0000000');
    const horizonTxs = [old, boundary, covered];
    const indexer: IndexerRoute = {
      health: healthOk({ startCursor: '100', cursor: '250' }),
      announcements: [toAnnouncement(covered)],
      cursor: '250',
    };

    const fast = makeRoutedFetch({ horizonTxs, indexer });
    const fastRun = await makeAdapter(fast.fetchFn, true).scan(keys);
    // Fast cold start: the pre-coverage payments are skipped.
    expect(countByTxHash(fastRun.payments)).toEqual({ HASH_200: 1 });

    const full = makeRoutedFetch({ horizonTxs, indexer });
    const fullRun = await makeAdapter(full.fetchFn, true).scan(keys, undefined, {
      exhaustive: true,
    });
    // Exhaustive: the genesis pre-segment discovers them — the boundary tx
    // included, exactly once — and the covered span still comes from the
    // indexer.
    expect(countByTxHash(fullRun.payments)).toEqual({
      HASH_50: 1,
      HASH_100: 1,
      HASH_200: 1,
    });
    // The indexer claims cursor 250 but this Horizon's head is 200: the
    // persisted cursor is CLAMPED to the head — an indexer claim alone must
    // never advance the cursor past what Horizon can corroborate. The next
    // scan re-covers (200, 250] and the CLI payment cache dedups.
    expect(fullRun.cursor).toBe('200');
    expect(txWalkCalls(full.calls, true)).toHaveLength(1);
    expect(full.calls.some((u) => u.includes('/announcements'))).toBe(true);
    expect(full.calls.some((u) => u.includes(`/transactions/${covered.tx.hash}/`))).toBe(false);
    // Meta pins the pre-segment's counting exactly: both pre-coverage
    // payments were candidates AND matches there, the covered span counted
    // in the indexer segment, and the empty tail triggered the head clamp.
    expect(fullRun.meta).toEqual({
      indexerUsed: true,
      indexerLagSeconds: 2,
      postCheck: 'ok',
      cursorClamped: true,
      segments: [
        { source: 'horizon', role: 'pre', candidates: 2, matches: 2 },
        { source: 'indexer', role: 'indexer', candidates: 1, matches: 1 },
        { source: 'horizon', role: 'tail', candidates: 0, matches: 0 },
      ],
    });
  });

  it('a malicious far-future feed cursor is clamped to the Horizon head — one response must not blind future scans', async () => {
    const { keys, raw } = keysToHex();
    const covered = mineNativeTx(raw, '200', '4.0000000');

    const { fetchFn } = makeRoutedFetch({
      horizonTxs: [covered],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '250' }),
        announcements: [toAnnouncement(covered)],
        // The short page reports a position far beyond the chain.
        cursor: '9000000000000000000',
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor, meta } = await adapter.scan(keys);

    // The payment itself still lands, but the poisoned position does not:
    // the persisted cursor is capped at the newest tx Horizon reports, so
    // the NEXT scan still sees everything after it.
    expect(countByTxHash(payments)).toEqual({ HASH_200: 1 });
    expect(cursor).toBe('200');
    expect(meta!.cursorClamped).toBe(true);
    expect(meta!.postCheck).toBe('ok');
  });

  it('post-segment health flip to degraded DISCARDS the segment: the tail re-walks the span, no dups, no cursor from indexer data', async () => {
    const { keys, raw } = keysToHex();
    const covered = mineNativeTx(raw, '200', '4.0000000');
    const lagging = mineNativeTx(raw, '300', '5.0000000');

    const { fetchFn, calls } = makeRoutedFetch({
      horizonTxs: [covered, lagging],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '250' }),
        healthSeq: [
          healthOk({ startCursor: '100', cursor: '250' }),
          // A gap was recorded while the segment was being paged.
          healthOk({ startCursor: '100', cursor: '250', status: 'degraded' }),
        ],
        announcements: [toAnnouncement(covered)],
        cursor: '250',
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor, meta } = await adapter.scan(keys);

    // Both payments present EXACTLY once — the discarded segment's find was
    // re-discovered by the Horizon tail, which re-walked from the segment's
    // start instead of the adopted position.
    expect(countByTxHash(payments)).toEqual({ HASH_200: 1, HASH_300: 1 });
    expect(cursor).toBe('300');
    expect(meta!.postCheck).toBe('unhealthy');
    // The re-walk really came from Horizon: the covered tx needed its
    // operations fetch after all (the indexer-served copy was thrown away).
    expect(
      calls.some((u) => u.includes(`/transactions/${covered.tx.hash}/operations`)),
    ).toBe(true);
    const tailSeg = meta!.segments.find((s) => s.role === 'tail')!;
    expect(tailSeg).toEqual({
      source: 'horizon',
      role: 'tail',
      candidates: 2,
      matches: 2,
    });
  });

  it('post-segment health UNREACHABLE discards the same way', async () => {
    const { keys, raw } = keysToHex();
    const covered = mineNativeTx(raw, '200', '4.0000000');

    const { fetchFn } = makeRoutedFetch({
      horizonTxs: [covered],
      indexer: {
        health: healthOk({ startCursor: '100', cursor: '250' }),
        healthSeq: [healthOk({ startCursor: '100', cursor: '250' }), 'reject'],
        announcements: [toAnnouncement(covered)],
        cursor: '250',
      },
    });
    const adapter = makeAdapter(fetchFn, true);

    const { payments, cursor, meta } = await adapter.scan(keys);

    expect(countByTxHash(payments)).toEqual({ HASH_200: 1 });
    expect(meta!.postCheck).toBe('unreachable');
    // Tail re-walked from the segment start and ended at the real head.
    expect(cursor).toBe('200');
  });

  it('indexerMaxLagSeconds plumbing: a cap of 1 skips lag 2; Infinity uses lag 999999', async () => {
    const { keys, raw } = keysToHex();
    const covered = mineNativeTx(raw, '200', '4.0000000');

    // Tight cap vs the fixture's lag of 2: skipped as stale, pure Horizon.
    const tight = makeRoutedFetch({
      horizonTxs: [covered],
      indexer: {
        health: healthOk({ lagSeconds: 2 }),
        announcements: [toAnnouncement(covered)],
        cursor: '300',
      },
    });
    const tightRun = await makeAdapter(tight.fetchFn, true, {
      indexerMaxLagSeconds: 1,
    }).scan(keys);
    expect(tightRun.meta.indexerUsed).toBe(false);
    expect(tightRun.meta.indexerSkipReason).toBe('stale');
    expect(tightRun.meta.indexerLagSeconds).toBe(2);
    expect(tight.calls.some((u) => u.includes('/announcements'))).toBe(false);
    expect(countByTxHash(tightRun.payments)).toEqual({ HASH_200: 1 });

    // Infinity disables the cap entirely: an extreme lag is still consumed
    // (the Horizon tail bounds correctness either way).
    const inf = makeRoutedFetch({
      horizonTxs: [covered],
      indexer: {
        health: healthOk({ lagSeconds: 999_999 }),
        announcements: [toAnnouncement(covered)],
        cursor: '300',
      },
    });
    const infRun = await makeAdapter(inf.fetchFn, true, {
      indexerMaxLagSeconds: Number.POSITIVE_INFINITY,
    }).scan(keys);
    expect(infRun.meta.indexerUsed).toBe(true);
    expect(infRun.meta.indexerSkipReason).toBeUndefined();
    expect(infRun.meta.indexerLagSeconds).toBe(999_999);
    expect(inf.calls.some((u) => u.includes('/announcements'))).toBe(true);
    expect(countByTxHash(infRun.payments)).toEqual({ HASH_200: 1 });
  });

  it('announcement source_account binds the sender-sponsored CB; without it the first-listed decoy wins', async () => {
    const { keys, raw } = keysToHex();
    const token = mineTokenTx(raw, '200');
    const DECOY_SPONSOR = Keypair.random().publicKey();
    const CB_DECOY_ID =
      '00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffff02';
    // Two live CBs with IDENTICAL asset+amount, differing only by sponsor.
    // The decoy is listed FIRST so the asset+amount fallback would pick it.
    const claimableBalancesByClaimant = {
      [token.stealthAddress!]: [
        {
          id: CB_DECOY_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: DECOY_SPONSOR,
          claimants: [{ destination: token.stealthAddress }],
        },
        {
          id: CB_ID,
          asset: ASSET,
          amount: '100.0000000',
          sponsor: SENDER,
          claimants: [{ destination: token.stealthAddress }],
        },
      ],
    };
    const indexer: IndexerRoute = {
      health: healthOk({ startCursor: '100', cursor: '250' }),
      announcements: [toAnnouncement(token)],
      cursor: '250',
    };

    // Indexer-served WITH source_account: sponsor-precise bind to the real
    // CB — with no per-tx Horizon operations round-trip.
    const precise = makeRoutedFetch({
      horizonTxs: [token],
      claimableBalancesByClaimant,
      indexer,
    });
    const preciseRun = await makeAdapter(precise.fetchFn, true).scan(keys);
    expect(preciseRun.payments).toHaveLength(1);
    expect(preciseRun.payments[0]!.claimableBalanceId).toBe(CB_ID);
    expect(precise.calls.some((u) => u.includes('/operations'))).toBe(false);

    // Control: the SAME announcement with source_account stripped (an older
    // feed) falls back to asset+amount and binds the first-listed decoy —
    // documenting exactly the ambiguity the field exists to remove.
    const stripped = { ...toAnnouncement(token) };
    delete stripped.source_account;
    const legacy = makeRoutedFetch({
      horizonTxs: [token],
      claimableBalancesByClaimant,
      indexer: { ...indexer, announcements: [stripped] },
    });
    const legacyRun = await makeAdapter(legacy.fetchFn, true).scan(keys);
    expect(legacyRun.payments).toHaveLength(1);
    expect(legacyRun.payments[0]!.claimableBalanceId).toBe(CB_DECOY_ID);
  });

  it('no-indexer scan meta: one full Horizon segment, indexerUsed false, no skip reason', async () => {
    const { keys, raw } = keysToHex();
    const mine = mineNativeTx(raw, '100', '5.0000000');
    const { fetchFn } = makeRoutedFetch({ horizonTxs: [mine, decoyTx('150')] });

    const { meta } = await makeAdapter(fetchFn, false).scan(keys);

    expect(meta).toEqual({
      indexerUsed: false,
      segments: [{ source: 'horizon', role: 'full', candidates: 2, matches: 1 }],
    });
    expect(meta.indexerSkipReason).toBeUndefined();
    expect(meta.indexerLagSeconds).toBeUndefined();
  });

  it('StealthClient.scanWithCursor surfaces the adapter meta under meta.account', async () => {
    const { keys, raw } = keysToHex();
    const covered = mineNativeTx(raw, '200', '4.0000000');
    const { fetchFn } = makeRoutedFetch({
      horizonTxs: [covered],
      indexer: {
        health: healthOk(),
        announcements: [toAnnouncement(covered)],
        cursor: '300',
      },
    });
    // The client builds its own Horizon/Indexer clients on the global fetch.
    vi.stubGlobal('fetch', fetchFn);
    try {
      const client = new StealthClient({
        network: 'testnet',
        methods: ['account'],
        horizonUrl: HORIZON,
        indexerUrl: INDEXER,
      });
      const result = await client.scanWithCursor(keys, { methods: ['account'] });

      expect(result.payments).toHaveLength(1);
      expect(result.meta?.account).toBeDefined();
      expect(result.meta!.account!.indexerUsed).toBe(true);
      expect(result.meta!.account!.segments.map((s) => s.role)).toEqual([
        'indexer',
        'tail',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
