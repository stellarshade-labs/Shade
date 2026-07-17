import { describe, it, expect, vi, afterEach } from 'vitest';
import { IndexerClient } from '../src/indexer.js';
import { IndexerHttpError, IndexerNetworkError } from '../src/errors.js';
import type { FetchLike } from '../src/horizon.js';

const BASE = 'http://indexer.test';

afterEach(() => {
  vi.useRealTimers();
});

describe('IndexerClient', () => {
  it('health: happy path decodes the body (trailing slash stripped)', async () => {
    const urls: string[] = [];
    const body = {
      status: 'ok',
      network: 'testnet',
      store: 'postgres',
      cursor: '12345',
      startCursor: '100',
      lastCloseTime: '2026-07-17T00:00:00Z',
      lagSeconds: 3,
      announcements: 42,
      ingest: { running: true },
    };
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => body };
    };
    const client = new IndexerClient(`${BASE}/`, fetchFn);
    expect(await client.health()).toEqual(body);
    expect(urls).toEqual([`${BASE}/health`]);
  });

  it('getAnnouncements: builds the cursor/limit query and decodes the page', async () => {
    const urls: string[] = [];
    const page = {
      records: [
        {
          hash: 'HASH_7',
          paging_token: '7',
          memo: Buffer.alloc(32).toString('base64'),
          memo_type: 'hash',
          successful: true,
          created_at: '2026-07-17T00:00:00Z',
          operations: [],
        },
      ],
      cursor: '7',
    };
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => page };
    };
    const client = new IndexerClient(BASE, fetchFn);
    expect(await client.getAnnouncements('42', 200)).toEqual(page);
    expect(await client.getAnnouncements()).toEqual(page);
    expect(urls).toEqual([
      `${BASE}/announcements?cursor=42&limit=200`,
      `${BASE}/announcements`,
    ]);
  });

  it('non-2xx throws IndexerHttpError with status + the body code', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'store unavailable', code: 'store_unavailable' }),
    });
    const client = new IndexerClient(BASE, fetchFn);
    const err = await client.getAnnouncements('1').catch((e) => e);
    expect(err).toBeInstanceOf(IndexerHttpError);
    expect((err as IndexerHttpError).code).toBe('indexer_http_error');
    expect((err as IndexerHttpError).status).toBe(503);
    expect((err as IndexerHttpError).indexerCode).toBe('store_unavailable');
    expect((err as Error).message).toBe(
      'Indexer /announcements?cursor=1 failed (503): store_unavailable',
    );
  });

  it('a rejected fetch throws IndexerNetworkError', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND indexer.test');
    };
    const client = new IndexerClient(BASE, fetchFn);
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(IndexerNetworkError);
    expect((err as IndexerNetworkError).code).toBe('indexer_network_error');
    expect((err as Error).message).toMatch(/unreachable.*ENOTFOUND/);
  });

  it('a hung request times out into IndexerNetworkError (default 10s)', async () => {
    vi.useFakeTimers();
    const fetchFn: FetchLike = () => new Promise(() => {});
    const client = new IndexerClient(BASE, fetchFn);
    const pending = client.health().catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;
    expect(err).toBeInstanceOf(IndexerNetworkError);
    expect((err as IndexerNetworkError).code).toBe('indexer_network_error');
    expect((err as Error).message).toMatch(/timed out after 10000ms/);
  });

  it('opts.timeoutMs overrides the default budget', async () => {
    vi.useFakeTimers();
    const fetchFn: FetchLike = () => new Promise(() => {});
    const client = new IndexerClient(BASE, fetchFn, { timeoutMs: 500 });
    const pending = client.getAnnouncements().catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBeInstanceOf(IndexerNetworkError);
  });

  it('a non-JSON error body still surfaces the HTTP status', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });
    const client = new IndexerClient(BASE, fetchFn);
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(IndexerHttpError);
    expect((err as IndexerHttpError).status).toBe(502);
  });

  it('a non-JSON 2xx body is a transport error (broken indexer)', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
    });
    const client = new IndexerClient(BASE, fetchFn);
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(IndexerNetworkError);
    expect((err as Error).message).toMatch(/invalid JSON/);
  });
});
