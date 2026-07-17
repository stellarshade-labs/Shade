import { describe, it, expect, vi, afterEach } from 'vitest';
import { RelayerClient } from '../src/relayer.js';
import { TransactionTimeoutError } from '../src/errors.js';
import type { TransactionStatusSource } from '../src/soroban.js';
import type { FetchLike } from '../src/horizon.js';

const XDR = 'AAAA-fake-envelope';
const HASH = 'RELAYED_HASH';

/** A fetch stub answering /relay and /sponsor-claim/submit with a fixed hash. */
function makeFetch(): { fetchFn: FetchLike; posts: string[] } {
  const posts: string[] = [];
  const fetchFn = (async (url: string) => {
    const u = String(url);
    posts.push(u);
    if (u.endsWith('/relay') || u.endsWith('/sponsor-claim/submit')) {
      return { ok: true, status: 200, json: async () => ({ txHash: HASH }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  }) as unknown as FetchLike;
  return { fetchFn, posts };
}

/** An RPC poll stub that records probed hashes and replays scripted statuses. */
function makeRpc(statuses: string[]): {
  rpcServer: TransactionStatusSource;
  polled: string[];
} {
  const polled: string[] = [];
  const rpcServer: TransactionStatusSource = {
    async getTransaction(hash: string) {
      polled.push(hash);
      // Replay the scripted statuses, then repeat the last one forever.
      const status = statuses[Math.min(polled.length - 1, statuses.length - 1)]!;
      return { status };
    },
  };
  return { rpcServer, polled };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RelayerClient confirm option (SDK-TXHASH-TRUST)', () => {
  it('relay({confirm: true}) polls the returned hash to SUCCESS before resolving', async () => {
    vi.useFakeTimers();
    const { fetchFn } = makeFetch();
    const { rpcServer, polled } = makeRpc(['NOT_FOUND', 'SUCCESS']);
    const client = new RelayerClient('http://relayer.test', fetchFn, { rpcServer });

    const pending = client.relay(XDR, { confirm: true });
    // Two poll iterations, 1s sleep before each probe.
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.txHash).toBe(HASH);
    expect(polled).toEqual([HASH, HASH]);
  });

  it('relay({confirm: true}) times out with TransactionTimeoutError carrying the hash when the tx never lands', async () => {
    vi.useFakeTimers();
    const { fetchFn } = makeFetch();
    // A relayer that returned a fabricated hash: the chain never sees it.
    const { rpcServer, polled } = makeRpc(['NOT_FOUND']);
    const client = new RelayerClient('http://relayer.test', fetchFn, { rpcServer });

    // Capture the rejection up front so the pending promise never surfaces as
    // an unhandled rejection while the fake clock advances.
    const settled = client.relay(XDR, { confirm: true }).then(
      () => null,
      (e: unknown) => e,
    );
    // 30 polls x 1s sleep — advance past the whole confirmation window.
    await vi.advanceTimersByTimeAsync(31_000);
    const err = await settled;

    expect(err).toBeInstanceOf(TransactionTimeoutError);
    const timeout = err as TransactionTimeoutError;
    expect(timeout.txHash).toBe(HASH);
    expect(timeout.retryable).toBe(false);
    expect(polled.length).toBe(30);
  });

  it('relay({confirm: true}) surfaces an on-chain FAILED status as an error', async () => {
    vi.useFakeTimers();
    const { fetchFn } = makeFetch();
    const { rpcServer } = makeRpc(['FAILED']);
    const client = new RelayerClient('http://relayer.test', fetchFn, { rpcServer });

    const settled = client.relay(XDR, { confirm: true }).then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/failed on-chain/);
  });

  it('relay({confirm: true}) without an rpcServer fails loudly instead of skipping the check', async () => {
    const { fetchFn } = makeFetch();
    const client = new RelayerClient('http://relayer.test', fetchFn);

    await expect(client.relay(XDR, { confirm: true })).rejects.toThrow(
      /rpcServer/,
    );
  });

  it('relay() without confirm never touches the RPC (default behavior unchanged)', async () => {
    const { fetchFn, posts } = makeFetch();
    const { rpcServer, polled } = makeRpc(['SUCCESS']);
    const client = new RelayerClient('http://relayer.test', fetchFn, { rpcServer });

    const result = await client.relay(XDR);

    expect(result.txHash).toBe(HASH);
    expect(polled).toHaveLength(0);
    expect(posts).toEqual(['http://relayer.test/relay']);
  });

  it('sponsorClaimSubmit({confirm: true}) polls the returned hash before resolving', async () => {
    vi.useFakeTimers();
    const { fetchFn } = makeFetch();
    const { rpcServer, polled } = makeRpc(['SUCCESS']);
    const client = new RelayerClient('http://relayer.test', fetchFn, { rpcServer });

    const pending = client.sponsorClaimSubmit(XDR, {
      stealthAddress: 'GSTEALTH',
      asset: 'USDC:GISSUER',
      balanceId: '00'.repeat(36),
      destination: 'GDEST',
      amount: '100.0000000',
      confirm: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.txHash).toBe(HASH);
    expect(polled).toEqual([HASH]);
  });

  it('sponsorClaimSubmit() without confirm never polls (default behavior unchanged)', async () => {
    const { fetchFn } = makeFetch();
    const { rpcServer, polled } = makeRpc(['SUCCESS']);
    const client = new RelayerClient('http://relayer.test', fetchFn, { rpcServer });

    const result = await client.sponsorClaimSubmit(XDR, {
      stealthAddress: 'GSTEALTH',
      asset: 'USDC:GISSUER',
      balanceId: '00'.repeat(36),
      destination: 'GDEST',
      amount: '100.0000000',
    });

    expect(result.txHash).toBe(HASH);
    expect(polled).toHaveLength(0);
  });
});
