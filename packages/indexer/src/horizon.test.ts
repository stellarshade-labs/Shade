import { describe, it, expect, vi } from 'vitest';
import { HorizonClient, type FetchLike } from './horizon.js';

function fetchReturning(body: unknown, status = 200): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('HorizonClient', () => {
  it('pages transactions ascending with cursor and limit', async () => {
    const records = [{ paging_token: '1', hash: 'h1', memo_type: 'hash', created_at: 't' }];
    const fetchFn = fetchReturning({ _embedded: { records } });
    const client = new HorizonClient('https://horizon.test/', fetchFn);
    expect(await client.getTransactions('42', 200)).toEqual(records);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://horizon.test/transactions?order=asc&limit=200&cursor=42',
    );
    // No cursor param on the first walk.
    await client.getTransactions(undefined, 200);
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://horizon.test/transactions?order=asc&limit=200',
    );
  });

  it('resolves the newest transaction token (undefined on an empty network)', async () => {
    const client = new HorizonClient(
      'https://horizon.test',
      fetchReturning({ _embedded: { records: [{ paging_token: '999' }] } }),
    );
    expect(await client.getLatestTransactionToken()).toBe('999');

    const empty = new HorizonClient(
      'https://horizon.test',
      fetchReturning({ _embedded: { records: [] } }),
    );
    expect(await empty.getLatestTransactionToken()).toBeUndefined();
  });

  it('fetches a transaction operations page verbatim', async () => {
    const ops = [{ id: 'op1', type: 'payment', extra: { deep: true } }];
    const fetchFn = fetchReturning({ _embedded: { records: ops } });
    const client = new HorizonClient('https://horizon.test', fetchFn);
    expect(await client.getOperations('abcd')).toEqual(ops);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://horizon.test/transactions/abcd/operations?limit=200',
    );
  });

  it('reads feed ledger bounds from the Horizon root document', async () => {
    const fetchFn = fetchReturning({
      horizon_version: '2.32.0',
      history_elder_ledger: 42,
      history_latest_ledger: 990,
    });
    const client = new HorizonClient('https://horizon.test', fetchFn);
    expect(await client.getFeedLedgerBounds()).toEqual({
      elderLedger: 42,
      latestLedger: 990,
    });
    expect(fetchFn).toHaveBeenCalledWith('https://horizon.test/');
  });

  it('omits bounds fields Horizon omits or serves as non-numbers', async () => {
    const partial = new HorizonClient(
      'https://horizon.test',
      fetchReturning({ history_latest_ledger: 990 }),
    );
    expect(await partial.getFeedLedgerBounds()).toEqual({ latestLedger: 990 });

    const garbage = new HorizonClient(
      'https://horizon.test',
      fetchReturning({ history_elder_ledger: 'soon', history_latest_ledger: null }),
    );
    expect(await garbage.getFeedLedgerBounds()).toEqual({});
  });

  it('getFeedLedgerBounds throws on a non-2xx response', async () => {
    const client = new HorizonClient('https://horizon.test', fetchReturning({}, 503));
    await expect(client.getFeedLedgerBounds()).rejects.toThrow('503');
  });

  it('throws on a non-2xx response, including the status', async () => {
    const client = new HorizonClient('https://horizon.test', fetchReturning({}, 429));
    await expect(client.getTransactions(undefined, 200)).rejects.toThrow('429');
  });

  it('propagates a JSON parse failure', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    const client = new HorizonClient('https://horizon.test', fetchFn);
    await expect(client.getOperations('abcd')).rejects.toThrow('Unexpected token');
  });
});
