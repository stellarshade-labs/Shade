import { describe, it, expect, vi } from 'vitest';
import type { HorizonFeed, HorizonTxRecord } from './horizon.js';
import { createIngester, ledgerOfToken, type IngestLogger } from './ingest.js';
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
      // No bounds → the continuity check is inert.
      getFeedLedgerBounds: async () => ({}),
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
      getFeedLedgerBounds: async () => ({}),
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
      getFeedLedgerBounds: async () => ({}),
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

  it('ingested records carry the transaction-level source account', async () => {
    const page = [tx(1, { source_account: 'GPAYERSOURCEACCOUNT' })];
    const getTransactions = vi.fn(async (cursor: string | undefined) =>
      cursor === '0' ? page : [],
    );
    const horizon: HorizonFeed = {
      getTransactions,
      getLatestTransactionToken: vi.fn(async () => undefined),
      getOperations: vi.fn(async () => []),
      getFeedLedgerBounds: async () => ({}),
    };
    const store = new MemoryAnnouncementStore();
    const ingester = createIngester({ horizon, store, intervalMs: 60_000, log: noopLog });
    try {
      await ingester.start('genesis');
      await waitFor(async () => (await store.getIngestState()).cursor === '1');
      const [row] = await store.getAnnouncements(undefined, 1);
      expect(row!.sourceAccount).toBe('GPAYERSOURCEACCOUNT');
    } finally {
      ingester.stop();
    }
  });

  it('a non-monotonic page aborts the tick before anything is stored', async () => {
    // A broken Horizon/proxy echoing a token at/below the request cursor.
    const getTransactions = vi.fn(async () => [tx(10), tx(11)]);
    const horizon: HorizonFeed = {
      getTransactions,
      getLatestTransactionToken: vi.fn(async () => undefined),
      getOperations: vi.fn(async () => []),
      getFeedLedgerBounds: async () => ({}),
    };
    const store = new MemoryAnnouncementStore();
    const ingester = createIngester({ horizon, store, intervalMs: 10, log: noopLog });
    try {
      await ingester.start('10');
      await waitFor(() => ingester.status().lastError !== null);

      // The message names both tokens; the cursor never advanced and nothing
      // (not even the in-order tx 11) was stored.
      expect(ingester.status().lastError).toContain('feed order violation');
      expect(ingester.status().lastError).toContain('10');
      expect((await store.getIngestState()).cursor).toBe('10');
      expect(await store.count()).toBe(0);
      expect(ingester.status().caughtUp).toBe(false);
    } finally {
      ingester.stop();
    }
  });

  describe('feed continuity check', () => {
    it('ledgerOfToken extracts the upper 32 TOID bits', () => {
      expect(ledgerOfToken('0')).toBe(0);
      expect(ledgerOfToken(String((123n << 32n) + 456n))).toBe(123);
    });

    it('records the hole on the SECOND consecutive observation, from the cursor ledger, then widens the SAME row', async () => {
      let elder = 100;
      const getFeedLedgerBounds = vi.fn(async () => ({
        elderLedger: elder,
        latestLedger: 5000,
      }));
      const horizon: HorizonFeed = {
        getTransactions: vi.fn(async () => []),
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds,
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        // Cursor parked in ledger 10; retention starts at 100. The recorded
        // range STARTS AT THE CURSOR LEDGER (its tail may be partially
        // unserved — a mid-ledger paging_token is indistinguishable from a
        // complete one once the ledger is dropped), so [10, 99].
        await ingester.start(String(10n << 32n));
        await waitFor(async () => (await store.getGaps()).length === 1);
        // Confirmation took at least two bounds fetches, never one.
        expect(getFeedLedgerBounds.mock.calls.length).toBeGreaterThanOrEqual(2);
        const [gap] = await store.getGaps();
        expect(gap).toEqual({
          fromLedger: 10,
          toLedger: 99,
          detectedAt: expect.any(String),
        });
        const firstDetectedAt = gap!.detectedAt;

        // Retention advances while the cursor stays stalled: the SAME row
        // widens and keeps its original detection time.
        elder = 150;
        await waitFor(async () => (await store.getGaps())[0]!.toLedger === 149);
        expect(await store.getGaps()).toEqual([
          { fromLedger: 10, toLedger: 149, detectedAt: firstDetectedAt },
        ]);
      } finally {
        ingester.stop();
      }
    });

    it('a hole observed ONCE (transient garbage bounds) records nothing', async () => {
      // First response claims retention starts at 100; every later one is
      // sane. One bad root document must not poison the permanent gap store.
      let first = true;
      const horizon: HorizonFeed = {
        getTransactions: vi.fn(async () => []),
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => {
          if (first) {
            first = false;
            return { elderLedger: 100, latestLedger: 5000 };
          }
          return { elderLedger: 2, latestLedger: 5000 };
        },
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        await ingester.start(String(10n << 32n));
        // The cleared pending observation lets paging start — and no gap
        // was ever recorded.
        await waitFor(() => ingester.status().lastPollAt !== null);
        await waitFor(() => !ingester.status().continuityStale);
        expect(await store.getGaps()).toEqual([]);
      } finally {
        ingester.stop();
      }
    });

    it('one-ledger boundaries: elder = cursor+2 records [cursor, cursor+1]; elder = cursor+1 is NOT a hole', async () => {
      const run = async (elder: number) => {
        const horizon: HorizonFeed = {
          getTransactions: vi.fn(async () => []),
          getLatestTransactionToken: vi.fn(async () => undefined),
          getOperations: vi.fn(async () => []),
          getFeedLedgerBounds: async () => ({
            elderLedger: elder,
            latestLedger: 5000,
          }),
        };
        const store = new MemoryAnnouncementStore();
        const ingester = createIngester({
          horizon,
          store,
          intervalMs: 5,
          gapCheckIntervalMs: 1,
          log: noopLog,
        });
        try {
          await ingester.start(String(10n << 32n));
          if (elder > 11) {
            await waitFor(async () => (await store.getGaps()).length === 1);
          } else {
            await waitFor(() => ingester.status().lastPollAt !== null);
          }
          return store.getGaps();
        } finally {
          ingester.stop();
        }
      };
      expect(await run(12)).toEqual([
        { fromLedger: 10, toLedger: 11, detectedAt: expect.any(String) },
      ]);
      expect(await run(11)).toEqual([]);
    });

    it('bounds from a mismatched network passphrase are discarded and gate paging until the URL is fixed', async () => {
      let passphrase = 'Public Global Stellar Network ; September 2015';
      const getTransactions = vi.fn(async () => []);
      const horizon: HorizonFeed = {
        getTransactions,
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => ({
          elderLedger: 100,
          latestLedger: 5000,
          networkPassphrase: passphrase,
        }),
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        expectedNetworkPassphrase: 'Test SDF Network ; September 2015',
        log: noopLog,
      });
      try {
        await ingester.start(String(10n << 32n));
        // Wrong network: the elder-past-cursor "hole" must NOT be recorded,
        // and paging must not start (a check that cannot be trusted is a
        // failed check).
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await store.getGaps()).toEqual([]);
        expect(getTransactions).not.toHaveBeenCalled();
        expect(ingester.status().continuityStale).toBe(true);

        // Operator fixes HORIZON_URL: the (real, still-present) hole now
        // confirms over two checks and ingestion resumes past it.
        passphrase = 'Test SDF Network ; September 2015';
        await waitFor(async () => (await store.getGaps()).length === 1);
        await waitFor(() => ingester.status().lastPollAt !== null);
        expect(await store.getGaps()).toEqual([
          { fromLedger: 10, toLedger: 99, detectedAt: expect.any(String) },
        ]);
      } finally {
        ingester.stop();
      }
    });

    it('honors the gap-check throttle: one check per interval however many ticks run', async () => {
      const getFeedLedgerBounds = vi.fn(async () => ({}));
      const getTransactions = vi.fn(async () => []);
      const horizon: HorizonFeed = {
        getTransactions,
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds,
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 60_000,
        log: noopLog,
      });
      try {
        await ingester.start('genesis');
        await waitFor(() => getTransactions.mock.calls.length >= 3);
        expect(getFeedLedgerBounds).toHaveBeenCalledTimes(1);
      } finally {
        ingester.stop();
      }
    });

    it('a recordGap failure aborts the tick BEFORE paging; the retry records the gap and only then ingests', async () => {
      const store = new MemoryAnnouncementStore();
      const origRecordGap = store.recordGap.bind(store);
      let failures = 1;
      store.recordGap = async (from, to, detectedAt) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('gap store down');
        }
        return origRecordGap(from, to, detectedAt);
      };
      // Horizon serves from its elder: the first available tx sits in ledger
      // 100, past the [10, 99] hole.
      const afterHole = String((100n << 32n) + 1n);
      const getTransactions = vi.fn(async (cursor: string | undefined) =>
        cursor === afterHole ? [] : [tx(Number(BigInt(afterHole)))],
      );
      const horizon: HorizonFeed = {
        getTransactions,
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => ({
          elderLedger: 100,
          latestLedger: 5000,
        }),
      };
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        await ingester.start(String(10n << 32n));
        // The failed confirmation surfaced as a tick error, with NOTHING
        // ingested — the cursor must never advance past an unrecorded hole.
        await waitFor(() => ingester.status().lastError === 'gap store down');
        expect(await store.count()).toBe(0);
        expect((await store.getIngestState()).cursor).toBe(String(10n << 32n));

        // The automatic retry records the gap, and only then does ingestion
        // resume past the hole.
        await waitFor(async () => (await store.getIngestState()).cursor === afterHole);
        expect(await store.getGaps()).toEqual([
          { fromLedger: 10, toLedger: 99, detectedAt: expect.any(String) },
        ]);
        expect(await store.count()).toBe(1);
      } finally {
        ingester.stop();
      }
    });

    it("a 'genesis' start against history beginning at ledger 2 is NOT a hole", async () => {
      const horizon: HorizonFeed = {
        getTransactions: vi.fn(async () => []),
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => ({ elderLedger: 2, latestLedger: 5000 }),
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        await ingester.start('genesis');
        await waitFor(() => ingester.status().lastPollAt !== null);
        expect(await store.getGaps()).toEqual([]);
        expect(ingester.status().resetSuspected).toBe(false);
      } finally {
        ingester.stop();
      }
    });

    it('LATCHES a reset after two consecutive observations, and the new chain growing past the cursor does NOT clear it', async () => {
      let latest = 100;
      const horizon: HorizonFeed = {
        getTransactions: vi.fn(async () => []),
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => ({ latestLedger: latest }),
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        // Cursor in ledger 200 while Horizon's tip is 100: 200 > 100 + 64.
        await ingester.start(String(200n << 32n));
        await waitFor(() => ingester.status().resetSuspected);

        // The chain catching back up must NOT clear the flag: the database
        // still holds a previous era. Only a restart clears it.
        latest = 250;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(ingester.status().resetSuspected).toBe(true);
      } finally {
        ingester.stop();
      }
    });

    it('a reset observed ONCE (stale load-balancer snapshot) never latches', async () => {
      let first = true;
      const horizon: HorizonFeed = {
        getTransactions: vi.fn(async () => []),
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => {
          if (first) {
            first = false;
            return { latestLedger: 100 };
          }
          return { latestLedger: 5000 };
        },
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        await ingester.start(String(200n << 32n));
        await waitFor(() => ingester.status().lastPollAt !== null);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(ingester.status().resetSuspected).toBe(false);
      } finally {
        ingester.stop();
      }
    });

    it('reset tolerance boundary: exactly latest+64 is normal, latest+65 confirms', async () => {
      const run = async (cursorLedger: bigint) => {
        const horizon: HorizonFeed = {
          getTransactions: vi.fn(async () => []),
          getLatestTransactionToken: vi.fn(async () => undefined),
          getOperations: vi.fn(async () => []),
          getFeedLedgerBounds: async () => ({ latestLedger: 100 }),
        };
        const store = new MemoryAnnouncementStore();
        const ingester = createIngester({
          horizon,
          store,
          intervalMs: 5,
          gapCheckIntervalMs: 1,
          log: noopLog,
        });
        try {
          await ingester.start(String(cursorLedger << 32n));
          if (cursorLedger === 165n) {
            await waitFor(() => ingester.status().resetSuspected);
            return true;
          }
          await waitFor(() => ingester.status().lastPollAt !== null);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return ingester.status().resetSuspected;
        } finally {
          ingester.stop();
        }
      };
      expect(await run(164n)).toBe(false);
      expect(await run(165n)).toBe(true);
    });

    it('a failing bounds fetch GATES paging (fail closed), is retried, and ingestion starts once it recovers', async () => {
      let failing = true;
      const getFeedLedgerBounds = vi.fn(async (): Promise<{
        elderLedger?: number;
        latestLedger?: number;
      }> => {
        if (failing) throw new Error('root unavailable');
        return {};
      });
      const getTransactions = vi.fn(async (cursor: string | undefined) =>
        cursor === '0' ? [tx(1)] : [],
      );
      const horizon: HorizonFeed = {
        getTransactions,
        getLatestTransactionToken: vi.fn(async () => undefined),
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds,
      };
      const store = new MemoryAnnouncementStore();
      const ingester = createIngester({
        horizon,
        store,
        intervalMs: 5,
        gapCheckIntervalMs: 1,
        log: noopLog,
      });
      try {
        await ingester.start('genesis');
        // The check is retried every tick while it fails…
        await waitFor(() => getFeedLedgerBounds.mock.calls.length >= 3);
        // …and NOTHING pages until it has succeeded once: a cold start
        // against a broken root document must not silently cross a
        // retention hole.
        expect(getTransactions).not.toHaveBeenCalled();
        expect(await store.count()).toBe(0);
        expect(ingester.status().continuityStale).toBe(true);

        failing = false;
        await waitFor(async () => (await store.getIngestState()).cursor === '1');
        expect(await store.count()).toBe(1);
        expect(ingester.status().lastError).toBeNull();
        expect(ingester.status().continuityStale).toBe(false);
      } finally {
        ingester.stop();
      }
    });

    it('reports stalled (never a silent frozen "ok") when ticks stop succeeding', async () => {
      vi.useFakeTimers();
      try {
        let failing = false;
        const horizon: HorizonFeed = {
          getTransactions: vi.fn(async () => {
            if (failing) throw new Error('feed broken');
            return [];
          }),
          getLatestTransactionToken: vi.fn(async () => undefined),
          getOperations: vi.fn(async () => []),
          getFeedLedgerBounds: async () => ({}),
        };
        const store = new MemoryAnnouncementStore();
        const ingester = createIngester({
          horizon,
          store,
          intervalMs: 1000,
          gapCheckIntervalMs: 3_600_000,
          log: noopLog,
        });
        try {
          await ingester.start('genesis');
          await vi.advanceTimersByTimeAsync(10);
          expect(ingester.status().stalled).toBe(false);

          failing = true;
          // STALL_MIN_MS (120s) dominates 5×1s: after two minutes of failing
          // ticks the ingester must say so.
          await vi.advanceTimersByTimeAsync(125_000);
          expect(ingester.status().stalled).toBe(true);
          expect(ingester.status().lastError).toBe('feed broken');

          failing = false;
          await vi.advanceTimersByTimeAsync(2_000);
          expect(ingester.status().stalled).toBe(false);
        } finally {
          ingester.stop();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('start cursor resolution', () => {
    function makeHorizon(latest: string | undefined) {
      const getTransactions = vi.fn(async () => [] as HorizonTxRecord[]);
      const getLatestTransactionToken = vi.fn(async () => latest);
      const horizon: HorizonFeed = {
        getTransactions,
        getLatestTransactionToken,
        getOperations: vi.fn(async () => []),
        getFeedLedgerBounds: async () => ({}),
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
