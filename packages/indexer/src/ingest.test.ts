import { describe, it, expect, vi } from 'vitest';
import type { HorizonFeed, HorizonTxRecord } from './horizon.js';
import { createIngester, type IngestLogger } from './ingest.js';
import { MemoryAnnouncementStore } from './store/memory.js';

const noopLog: IngestLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** A synthetic Horizon tx record: hash memo + successful unless overridden. */
function tx(
  token: number,
  overrides: Partial<HorizonTxRecord> = {},
): HorizonTxRecord {
  return {
    paging_token: String(token),
    hash: `hash-${token}`,
    memo_type: 'hash',
    memo: Buffer.alloc(32, token % 251).toString('base64'),
    successful: true,
    created_at: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

/** Poll `cond` (sync or async) until true or the deadline passes. */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

describe('createIngester', () => {
  it('keeps only successful hash-memo txs, with operations verbatim', async () => {
    const page = [
      tx(1),
      tx(2, { memo_type: 'text', memo: 'hello' }),
      tx(3, { successful: false }),
      tx(4, { memo: undefined }),
      tx(5),
    ];
    const getTransactions = vi.fn(async (cursor: string | undefined) =>
      cursor === '0' ? page : [],
    );
    const getOperations = vi.fn(async (hash: string) => [
      { id: `ops-for-${hash}`, type: 'payment' },
    ]);
    const horizon: HorizonFeed = {
      getTransactions,
      getLatestTransactionToken: vi.fn(async () => undefined),
      getOperations,
    };
    const store = new MemoryAnnouncementStore();
    const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
    try {
      await ingester.start('genesis');
      await waitFor(async () => (await store.getIngestState()).cursor === '5');

      // Cursor advanced over the WHOLE page, but only txs 1 and 5 were kept.
      expect(await store.count()).toBe(2);
      const rows = await store.getAnnouncements(undefined, 10);
      expect(rows.map((r) => r.pagingToken)).toEqual(['1', '5']);
      expect(rows[0]).toEqual({
        pagingToken: '1',
        hash: 'hash-1',
        memo: page[0]!.memo,
        closeTime: '2026-07-17T00:00:00.000Z',
        operations: [{ id: 'ops-for-hash-1', type: 'payment' }],
      });
      // Ops were fetched only for the kept announcements.
      expect(getOperations).toHaveBeenCalledTimes(2);
      expect(getOperations).toHaveBeenCalledWith('hash-1');
      expect(getOperations).toHaveBeenCalledWith('hash-5');
      expect(ingester.status().caughtUp).toBe(true);
      expect(ingester.status().lastError).toBeNull();
    } finally {
      ingester.stop();
    }
  });

  it('drains a multi-page cold catch-up within a single tick', async () => {
    const pages: Record<string, HorizonTxRecord[]> = {
      '0': Array.from({ length: 200 }, (_, i) => tx(i + 1)),
      '200': Array.from({ length: 200 }, (_, i) => tx(i + 201)),
      '400': Array.from({ length: 3 }, (_, i) => tx(i + 401)),
    };
    const getTransactions = vi.fn(
      async (cursor: string | undefined) => pages[cursor ?? ''] ?? [],
    );
    const horizon: HorizonFeed = {
      getTransactions,
      getLatestTransactionToken: vi.fn(async () => undefined),
      getOperations: vi.fn(async () => []),
    };
    const store = new MemoryAnnouncementStore();
    // intervalMs is huge: all progress below must come from the FIRST tick.
    const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
    try {
      await ingester.start('genesis');
      await waitFor(async () => (await store.getIngestState()).cursor === '403');

      expect(await store.count()).toBe(403);
      expect(getTransactions).toHaveBeenCalledTimes(3);
      expect(getTransactions.mock.calls.map(([cursor]) => cursor)).toEqual([
        '0',
        '200',
        '400',
      ]);
      expect(ingester.status().caughtUp).toBe(true);
    } finally {
      ingester.stop();
    }
  });

  it('an ops-fetch failure aborts the tick without advancing the cursor; the next tick retries', async () => {
    let failOps = true;
    const getTransactions = vi.fn(async (cursor: string | undefined) =>
      cursor === '0' ? [tx(1), tx(2)] : [],
    );
    const getOperations = vi.fn(async (hash: string) => {
      if (failOps && hash === 'hash-2') throw new Error('horizon 429');
      return [{ id: `ops-for-${hash}` }];
    });
    const horizon: HorizonFeed = {
      getTransactions,
      getLatestTransactionToken: vi.fn(async () => undefined),
      getOperations,
    };
    const store = new MemoryAnnouncementStore();
    const ingester = createIngester({ horizon, store, intervalMs: 10, log: noopLog });
    try {
      await ingester.start('genesis');
      await waitFor(() => ingester.status().lastError !== null);

      // INVARIANT: the failed page was never insertBatch'd — cursor still at
      // the seed and NOTHING stored (not even tx 1, whose ops fetch worked).
      expect(ingester.status().lastError).toContain('horizon 429');
      expect((await store.getIngestState()).cursor).toBe('0');
      expect(await store.count()).toBe(0);
      expect(ingester.status().caughtUp).toBe(false);

      // Next tick retries from the SAME cursor and now succeeds.
      failOps = false;
      await waitFor(async () => (await store.getIngestState()).cursor === '2');
      expect(await store.count()).toBe(2);
      expect(ingester.status().lastError).toBeNull();
    } finally {
      ingester.stop();
    }
  });

  describe('start cursor resolution', () => {
    function makeHorizon(latest: string | undefined) {
      const getTransactions = vi.fn(async () => [] as HorizonTxRecord[]);
      const getLatestTransactionToken = vi.fn(async () => latest);
      const horizon: HorizonFeed = {
        getTransactions,
        getLatestTransactionToken,
        getOperations: vi.fn(async () => []),
      };
      return { horizon, getTransactions, getLatestTransactionToken };
    }

    it("'now' resolves to the newest tx token on a fresh store", async () => {
      const { horizon, getTransactions } = makeHorizon('5000');
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
      try {
        await ingester.start('now');
        const state = await store.getIngestState();
        expect(state.cursor).toBe('5000');
        expect(state.startCursor).toBe('5000');
        expect(await store.count()).toBe(0);
        // The first tick polls from the resolved position.
        await waitFor(() => getTransactions.mock.calls.length > 0);
        expect(getTransactions).toHaveBeenCalledWith('5000', 200);
      } finally {
        ingester.stop();
      }
    });

    it("'now' on an empty network falls back to '0'", async () => {
      const { horizon } = makeHorizon(undefined);
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
      try {
        await ingester.start('now');
        expect((await store.getIngestState()).cursor).toBe('0');
      } finally {
        ingester.stop();
      }
    });

    it("'genesis' starts from the beginning of the feed", async () => {
      const { horizon, getLatestTransactionToken } = makeHorizon('5000');
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
      try {
        await ingester.start('genesis');
        const state = await store.getIngestState();
        expect(state.cursor).toBe('0');
        expect(state.startCursor).toBe('0');
        expect(getLatestTransactionToken).not.toHaveBeenCalled();
      } finally {
        ingester.stop();
      }
    });

    it('a decimal spec is used as-is', async () => {
      const { horizon } = makeHorizon('5000');
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
      try {
        await ingester.start('12345');
        const state = await store.getIngestState();
        expect(state.cursor).toBe('12345');
        expect(state.startCursor).toBe('12345');
      } finally {
        ingester.stop();
      }
    });

    it('an unsupported spec rejects and leaves the store untouched', async () => {
      const { horizon } = makeHorizon('5000');
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
      try {
        await expect(ingester.start('yesterday')).rejects.toThrow(/INGEST_START/);
        expect(await store.getIngestState()).toEqual({
          cursor: null,
          startCursor: null,
          lastCloseTime: null,
        });
      } finally {
        ingester.stop();
      }
    });

    it('a persisted cursor beats INGEST_START on restart', async () => {
      const { horizon, getLatestTransactionToken, getTransactions } =
        makeHorizon('5000');
      const store = new MemoryAnnouncementStore();
      // Simulate a previous run that ingested up to 777.
      await store.setStartCursor('777');
      await store.insertBatch([], '777', null);

      const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
      try {
        await ingester.start('now');
        const state = await store.getIngestState();
        expect(state.cursor).toBe('777');
        expect(state.startCursor).toBe('777');
        expect(getLatestTransactionToken).not.toHaveBeenCalled();
        await waitFor(() => getTransactions.mock.calls.length > 0);
        expect(getTransactions).toHaveBeenCalledWith('777', 200);
      } finally {
        ingester.stop();
      }
    });
  });
});
