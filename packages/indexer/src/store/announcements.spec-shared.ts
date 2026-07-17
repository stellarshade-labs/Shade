import { describe, it, expect, afterEach } from 'vitest';
import type { AnnouncementRecord, AnnouncementStore } from './types.js';

/** A base64 32-byte R, as Horizon serializes a MemoHash. */
const MEMO = Buffer.alloc(32, 7).toString('base64');

/**
 * A backend factory for the shared {@link AnnouncementStore} spec. Returns a
 * fresh, empty store plus a `cleanup` that tears the backing store down.
 */
export interface AnnouncementStoreHarness {
  store: AnnouncementStore;
  /** Tear down the backing store. */
  cleanup: () => Promise<void>;
}

/** A synthetic announcement fixture. `closeTime` uses millisecond precision so
 *  the string round-trips identically through TIMESTAMPTZ → toISOString(). */
function record(
  token: string,
  overrides: Partial<AnnouncementRecord> = {},
): AnnouncementRecord {
  return {
    pagingToken: token,
    hash: `hash-${token}`,
    memo: MEMO,
    closeTime: '2026-07-17T00:00:00.000Z',
    operations: [
      { id: `op-${token}`, type: 'create_account', account: 'GAAAA', starting_balance: '5.0000000' },
    ],
    ...overrides,
  };
}

/**
 * The backend-agnostic behavioural contract for an {@link AnnouncementStore}.
 * Every implementation (memory, Postgres) runs this identical assertion set
 * via its own `makeHarness` factory, so no coverage is lost across backends.
 */
export function describeAnnouncementStoreSpec(
  name: string,
  makeHarness: () => Promise<AnnouncementStoreHarness>,
): void {
  describe(name, () => {
    let harness: AnnouncementStoreHarness | null = null;

    async function open(): Promise<AnnouncementStore> {
      harness = await makeHarness();
      return harness.store;
    }

    afterEach(async () => {
      if (harness) {
        await harness.cleanup();
        harness = null;
      }
    });

    it('starts empty: null ingest state, zero count, empty feed', async () => {
      const store = await open();
      expect(await store.getIngestState()).toEqual({
        cursor: null,
        startCursor: null,
        lastCloseTime: null,
      });
      expect(await store.count()).toBe(0);
      expect(await store.getAnnouncements(undefined, 10)).toEqual([]);
    });

    it('persists a batch with its cursor and lastCloseTime together', async () => {
      const store = await open();
      await store.insertBatch(
        [record('1'), record('2')],
        '2',
        '2026-07-17T00:00:00.000Z',
      );
      const state = await store.getIngestState();
      expect(state.cursor).toBe('2');
      expect(state.lastCloseTime).toBe('2026-07-17T00:00:00.000Z');
      const rows = await store.getAnnouncements(undefined, 10);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(record('1'));
      expect(rows[1]).toEqual(record('2'));
    });

    it('replaying a batch is idempotent (ON CONFLICT DO NOTHING semantics)', async () => {
      const store = await open();
      const batch = [record('1'), record('2')];
      await store.insertBatch(batch, '2', '2026-07-17T00:00:00.000Z');
      // A crash-replay re-inserts the same page (plus one new record).
      await store.insertBatch(
        [...batch, record('3')],
        '3',
        '2026-07-17T00:00:01.000Z',
      );
      expect(await store.count()).toBe(3);
      const rows = await store.getAnnouncements(undefined, 10);
      expect(rows.map((r) => r.pagingToken)).toEqual(['1', '2', '3']);
      expect((await store.getIngestState()).cursor).toBe('3');
    });

    it('advances the cursor atomically with an empty batch', async () => {
      const store = await open();
      await store.insertBatch([], '4711', null);
      expect(await store.count()).toBe(0);
      const state = await store.getIngestState();
      expect(state.cursor).toBe('4711');
      expect(state.lastCloseTime).toBeNull();
    });

    it('orders and filters cursors numerically, not lexicographically', async () => {
      const store = await open();
      // Deliberately unordered insert; '999' < '1000' numerically even though
      // it sorts after it lexicographically.
      await store.insertBatch(
        [record('1000'), record('999'), record('1001')],
        '1001',
        '2026-07-17T00:00:00.000Z',
      );
      const all = await store.getAnnouncements(undefined, 10);
      expect(all.map((r) => r.pagingToken)).toEqual(['999', '1000', '1001']);
      // Strictly greater than the cursor: '999' itself is excluded, '1000' is
      // included (a lexicographic compare would drop it).
      const after999 = await store.getAnnouncements('999', 10);
      expect(after999.map((r) => r.pagingToken)).toEqual(['1000', '1001']);
    });

    it('applies strict-greater cursor semantics and the row limit', async () => {
      const store = await open();
      await store.insertBatch(
        [record('10'), record('20'), record('30'), record('40')],
        '40',
        '2026-07-17T00:00:00.000Z',
      );
      const page = await store.getAnnouncements('10', 2);
      expect(page.map((r) => r.pagingToken)).toEqual(['20', '30']);
      const rest = await store.getAnnouncements('30', 2);
      expect(rest.map((r) => r.pagingToken)).toEqual(['40']);
      expect(await store.getAnnouncements('40', 2)).toEqual([]);
    });

    it('records the start cursor once (later calls are no-ops)', async () => {
      const store = await open();
      await store.setStartCursor('500');
      await store.setStartCursor('900');
      expect((await store.getIngestState()).startCursor).toBe('500');
    });

    it('counts stored announcements', async () => {
      const store = await open();
      await store.insertBatch(
        [record('1'), record('2'), record('3')],
        '3',
        '2026-07-17T00:00:00.000Z',
      );
      expect(await store.count()).toBe(3);
    });

    it('preserves operations verbatim (no field projection)', async () => {
      const store = await open();
      const operations = [
        {
          id: 'op-1',
          type: 'create_claimable_balance',
          asset: 'USDC:GISSUER',
          claimants: [{ destination: 'GDEST', predicate: { unconditional: true } }],
          some_future_field: { nested: [1, 2, 3] },
        },
      ];
      await store.insertBatch(
        [record('7', { operations })],
        '7',
        '2026-07-17T00:00:00.000Z',
      );
      const [row] = await store.getAnnouncements(undefined, 1);
      expect(row!.operations).toEqual(operations);
    });
  });
}
