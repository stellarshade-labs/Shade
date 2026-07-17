import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  RelayerPool,
  normalizeRelayList,
} from '../src/relayerPool.js';
import { RelayerClient, type RelayerHealth } from '../src/relayer.js';
import type { FetchLike } from '../src/horizon.js';
import {
  NoHealthyRelayerError,
  RelayerHttpError,
  RelayerNetworkError,
} from '../src/errors.js';

const A = 'http://a.test';
const B = 'http://b.test';

function healthOk(over?: Partial<RelayerHealth>): RelayerHealth {
  return {
    status: 'ok',
    network: 'testnet',
    balance: '50.0000000',
    requireCredit: false,
    maxRelayFeeXlm: 0.1,
    ...over,
  };
}

interface Route {
  /** Health body served for this URL prefix, or a behavior marker. */
  health: RelayerHealth | 'reject' | 'hang' | { errorStatus: number };
}

/**
 * FetchLike stub routing `/health` by URL prefix and recording every call.
 * Non-health paths 404 — the pool itself only ever fetches health.
 */
function routedFetch(routes: Record<string, Route>): {
  fetchFn: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const route = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix),
    )?.[1];
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    if (route.health === 'reject') {
      throw new Error(`getaddrinfo ENOTFOUND ${url}`);
    }
    if (route.health === 'hang') {
      return new Promise(() => {});
    }
    if ('errorStatus' in route.health) {
      return {
        ok: false,
        status: route.health.errorStatus,
        json: async () => ({ error: 'boom' }),
      };
    }
    const body = route.health;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchFn, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeRelayList', () => {
  it('collapses undefined/empty/whitespace to undefined and trims entries', () => {
    expect(normalizeRelayList(undefined)).toBeUndefined();
    expect(normalizeRelayList([])).toBeUndefined();
    expect(normalizeRelayList([' ', ''])).toBeUndefined();
    expect(normalizeRelayList('')).toBeUndefined();
    expect(normalizeRelayList(' http://a.test ')).toEqual([A]);
    expect(normalizeRelayList([A, ' ', B])).toEqual([A, B]);
  });

  it('RelayerPool.from mirrors it (undefined pool for empty input)', () => {
    expect(RelayerPool.from(undefined)).toBeUndefined();
    expect(RelayerPool.from([])).toBeUndefined();
    expect(RelayerPool.from(A)!.candidates).toEqual([A]);
  });
});

describe('RelayerPool selection', () => {
  it("'first' picks the first healthy candidate", async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    expect(await pool.select()).toBe(A);
  });

  it("'random' spreads by the injected rng (deterministic per rng)", async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    // Fisher–Yates over [A, B]: rng 0 swaps -> B first; rng ~1 keeps A first.
    const poolSwap = new RelayerPool([A, B], { fetchFn, rng: () => 0 });
    expect(await poolSwap.select()).toBe(B);
    const poolKeep = new RelayerPool([A, B], { fetchFn, rng: () => 0.99 });
    expect(await poolKeep.select()).toBe(A);
  });

  it('a dead first candidate is skipped (acceptance shape: dead.invalid + live)', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: 'reject' },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], { network: 'testnet', fetchFn });
    const ran: string[] = [];
    const result = await pool.withRelayer(async (_client, url) => {
      ran.push(url);
      return `ok-${url}`;
    });
    expect(result).toBe(`ok-${B}`);
    expect(ran).toEqual([B]);
  });

  it('all candidates dead -> NoHealthyRelayerError naming per-URL reasons', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: 'reject' },
      [B]: { health: { errorStatus: 503 } },
    });
    const pool = new RelayerPool([A, B], { network: 'testnet', fetchFn });
    const err = await pool.select().catch((e) => e);
    expect(err).toBeInstanceOf(NoHealthyRelayerError);
    const candidates = (err as NoHealthyRelayerError).candidates;
    expect(candidates[A]).toMatch(/unreachable/);
    expect(candidates[B]).toBe('http_503');
    expect((err as Error).message).toContain(A);
    expect((err as Error).message).toContain(B);
  });

  it('rejects a network mismatch, tolerates an unreported network', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk({ network: 'public' }) },
      [B]: { health: healthOk({ network: undefined }) },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    // A contradicts the expected network; B omits it (older relayer) -> passes.
    expect(await pool.select()).toBe(B);

    const onlyA = new RelayerPool([A, 'http://c.test'], {
      network: 'testnet',
      fetchFn,
    });
    const err = await onlyA.select().catch((e) => e);
    expect(err).toBeInstanceOf(NoHealthyRelayerError);
    expect((err as NoHealthyRelayerError).candidates[A]).toBe(
      'network_mismatch (public != testnet)',
    );
  });

  it('credit-gated candidates need funding auth in the call context (fail-closed)', async () => {
    const { fetchFn } = routedFetch({
      // requireCredit true AND missing both mean "gated" (relayer default-ON).
      [A]: { health: healthOk({ requireCredit: true }) },
      [B]: { health: healthOk({ requireCredit: undefined }) },
    });
    const pool = new RelayerPool([A, B], { network: 'testnet', fetchFn });

    const bare = await pool.select().catch((e) => e);
    expect(bare).toBeInstanceOf(NoHealthyRelayerError);
    expect((bare as NoHealthyRelayerError).candidates[A]).toBe(
      'credit_gated_no_funding_auth',
    );
    expect((bare as NoHealthyRelayerError).candidates[B]).toBe(
      'credit_gated_no_funding_auth',
    );

    const funder = Keypair.random();
    const withAuth = await pool.select({
      fundingAccount: funder.publicKey(),
      fundingSigner: (m) => funder.sign(Buffer.from(m)),
    });
    expect([A, B]).toContain(withAuth);
  });

  it('rejects a balance below the minimum (default 1 XLM, overridable)', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk({ balance: '0.4000000' }) },
      [B]: { health: healthOk({ balance: '2.0000000' }) },
    });
    const pool = new RelayerPool([A, B], { network: 'testnet', fetchFn });
    expect(await pool.select()).toBe(B);

    const strict = new RelayerPool([A, B], {
      network: 'testnet',
      fetchFn,
      minBalanceXlm: 10,
    });
    const err = await strict.select().catch((e) => e);
    expect(err).toBeInstanceOf(NoHealthyRelayerError);
    expect((err as NoHealthyRelayerError).candidates[B]).toBe(
      'balance_below_min (2.0000000 < 10)',
    );
  });
});

describe('RelayerPool failover semantics', () => {
  it('fails over on a 5xx from the first attempt, returns the second result', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    const attempts: string[] = [];
    const result = await pool.withRelayer(async (_client, url) => {
      attempts.push(url);
      if (url === A) throw new RelayerHttpError('/relay', 500, 'server_error');
      return `ok-${url}`;
    });
    expect(attempts).toEqual([A, B]);
    expect(result).toBe(`ok-${B}`);
  });

  it('fails over on a transport error from the first attempt', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    const result = await pool.withRelayer(async (_client, url) => {
      if (url === A) throw new RelayerNetworkError('/relay', 'socket hang up');
      return `ok-${url}`;
    });
    expect(result).toBe(`ok-${B}`);
  });

  it('a 4xx stops immediately — the request would only repeat', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    const attempts: string[] = [];
    const err = await pool
      .withRelayer(async (_client, url) => {
        attempts.push(url);
        throw new RelayerHttpError('/relay', 402, 'insufficient_credit');
      })
      .catch((e) => e);
    expect(attempts).toEqual([A]);
    expect(err).toBeInstanceOf(RelayerHttpError);
    expect((err as RelayerHttpError).relayerCode).toBe('insufficient_credit');
  });

  it('non-transport errors (e.g. confirm timeouts) never trigger a second submit', async () => {
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    const attempts: string[] = [];
    const boom = new Error('TransactionTimeoutError-like');
    const err = await pool
      .withRelayer(async (_client, url) => {
        attempts.push(url);
        throw boom;
      })
      .catch((e) => e);
    expect(attempts).toEqual([A]);
    expect(err).toBe(boom);
  });

  it('probe timeout: an unresponsive candidate is excluded within the 2.5s budget', async () => {
    vi.useFakeTimers();
    const { fetchFn } = routedFetch({
      [A]: { health: 'hang' },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], { network: 'testnet', fetchFn });
    const pending = pool.probe();
    await vi.advanceTimersByTimeAsync(2_500);
    const outcomes = await pending;
    expect(outcomes.find((o) => o.url === A)?.reason).toBe('timeout');
    expect(outcomes.find((o) => o.url === B)?.health).toBeDefined();
  });

  it('attempt timeout: a hung first submit fails over after 10s', async () => {
    vi.useFakeTimers();
    const { fetchFn } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], {
      network: 'testnet',
      selection: 'first',
      fetchFn,
    });
    const attempts: string[] = [];
    const pending = pool.withRelayer(async (_client, url) => {
      attempts.push(url);
      if (url === A) return new Promise<string>(() => {}); // hangs forever
      return `ok-${url}`;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(attempts).toEqual([A, B]);
    expect(result).toBe(`ok-${B}`);
  });

  it('single candidate: pure pass-through — no probe, no timeout, fn runs once', async () => {
    const { fetchFn, calls } = routedFetch({ [A]: { health: healthOk() } });
    const pool = new RelayerPool([A], { network: 'testnet', fetchFn });
    const ran: string[] = [];
    const result = await pool.withRelayer(async (client, url) => {
      ran.push(url);
      expect(client).toBeInstanceOf(RelayerClient);
      return 'done';
    });
    expect(result).toBe('done');
    expect(ran).toEqual([A]);
    // Byte-identical to the old single-URL path: zero /health traffic.
    expect(calls).toHaveLength(0);
    expect(await pool.select()).toBe(A);
    expect(calls).toHaveLength(0);
  });

  it('probe results are cached per TTL; probe(true) refreshes', async () => {
    const { fetchFn, calls } = routedFetch({
      [A]: { health: healthOk() },
      [B]: { health: healthOk() },
    });
    const pool = new RelayerPool([A, B], { network: 'testnet', fetchFn });
    await pool.select();
    await pool.select();
    await pool.withRelayer(async () => 'x');
    // One /health per candidate across all three calls.
    expect(calls.filter((u) => u.endsWith('/health'))).toHaveLength(2);
    await pool.probe(true);
    expect(calls.filter((u) => u.endsWith('/health'))).toHaveLength(4);
  });
});

describe('RelayerClient typed transport errors', () => {
  it('non-2xx throws RelayerHttpError with status/relayerCode and the unchanged message', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: 'Insufficient credit', code: 'insufficient_credit' }),
    });
    const client = new RelayerClient(A, fetchFn);
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(RelayerHttpError);
    expect((err as RelayerHttpError).status).toBe(402);
    expect((err as RelayerHttpError).relayerCode).toBe('insufficient_credit');
    expect((err as Error).message).toBe(
      'Relayer /health failed (402): insufficient_credit',
    );
  });

  it('a rejected fetch throws RelayerNetworkError', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND a.test');
    };
    const client = new RelayerClient(A, fetchFn);
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(RelayerNetworkError);
    expect((err as Error).message).toMatch(/unreachable.*ENOTFOUND/);
  });

  it('a non-JSON error body still surfaces the HTTP status', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });
    const client = new RelayerClient(A, fetchFn);
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(RelayerHttpError);
    expect((err as RelayerHttpError).status).toBe(502);
  });
});
