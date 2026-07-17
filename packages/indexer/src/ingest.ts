import type { HorizonFeed } from './horizon.js';
import type { AnnouncementRecord, AnnouncementStore } from './store/types.js';

/** Horizon's maximum (and our fixed) transaction page size. */
const PAGE_LIMIT = 200;

/** The logging surface the ingester needs (the package logger satisfies it). */
export interface IngestLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface IngesterStatus {
  lastPollAt: string | null;
  lastError: string | null;
  caughtUp: boolean;
}

export interface Ingester {
  start(startCursorSpec: string): Promise<void>;
  stop(): void;
  status(): IngesterStatus;
}

export interface IngesterOptions {
  horizon: HorizonFeed;
  store: AnnouncementStore;
  intervalMs: number;
  log: IngestLogger;
}

/**
 * The Horizon → store ingest loop.
 *
 * `start(startCursorSpec)` resolves the initial cursor ONLY on a fresh store
 * ('now' → the newest tx's paging_token, 'genesis' → '0', a decimal token →
 * as-is); once a cursor is persisted, the persisted state wins and the spec is
 * ignored. Ticks run on a setTimeout chain — the next tick is scheduled only
 * AFTER the previous one finishes, so ticks never overlap. A tick keeps paging
 * while pages come back full (cold catch-up drains in one tick) and stops at a
 * short or empty page.
 *
 * INVARIANT: the cursor never advances past a transaction whose operations
 * fetch failed — any error aborts the tick BEFORE that page's insertBatch,
 * records lastError, and the next tick retries from the same cursor. An
 * announcement silently skipped would be a hidden payment.
 */
export function createIngester({
  horizon,
  store,
  intervalMs,
  log,
}: IngesterOptions): Ingester {
  let cursor: string | null = null;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let lastPollAt: string | null = null;
  let lastError: string | null = null;
  let caughtUp = false;

  async function resolveStartCursor(spec: string): Promise<string> {
    if (spec === 'now') {
      // Empty network (no transactions yet) → start from the beginning.
      return (await horizon.getLatestTransactionToken()) ?? '0';
    }
    if (spec === 'genesis') return '0';
    if (/^\d+$/.test(spec)) return spec;
    throw new Error(
      `INGEST_START='${spec}' is not supported: use 'now', 'genesis', or a ` +
        'decimal Horizon paging token.',
    );
  }

  async function tick(): Promise<void> {
    try {
      for (;;) {
        if (!running) return;
        const page = await horizon.getTransactions(cursor ?? undefined, PAGE_LIMIT);
        if (page.length === 0) break;

        const collected: AnnouncementRecord[] = [];
        for (const tx of page) {
          // Only hash-memo announcements from successful transactions. Horizon
          // omits `successful` on some record shapes; treat only an explicit
          // false as failed.
          if (tx.memo_type !== 'hash' || !tx.memo || tx.successful === false) {
            continue;
          }
          // Serial ops fetches on purpose (simple, and each throw must abort
          // the tick before this page's insertBatch — see the invariant above).
          const operations = await horizon.getOperations(tx.hash);
          collected.push({
            pagingToken: tx.paging_token,
            hash: tx.hash,
            memo: tx.memo,
            closeTime: tx.created_at,
            operations,
          });
        }

        // ONE atomic write per page: announcements + cursor + lastCloseTime.
        const last = page[page.length - 1]!;
        await store.insertBatch(collected, last.paging_token, last.created_at);
        cursor = last.paging_token;

        if (page.length < PAGE_LIMIT) break;
      }
      caughtUp = true;
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      caughtUp = false;
      log.warn('Ingest tick failed; retrying from the same cursor', {
        error: lastError,
        cursor,
      });
    } finally {
      lastPollAt = new Date().toISOString();
      if (running) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  }

  return {
    async start(startCursorSpec: string): Promise<void> {
      if (running) return;
      const state = await store.getIngestState();
      if (state.cursor !== null) {
        // Persisted progress wins; INGEST_START only seeds a FRESH store.
        cursor = state.cursor;
      } else {
        const resolved = await resolveStartCursor(startCursorSpec);
        await store.setStartCursor(resolved);
        // Persist the resolved position immediately (empty batch advances the
        // cursor atomically) so a restart before the first tick does not
        // re-resolve 'now' to a later position and skip the gap.
        await store.insertBatch([], resolved, null);
        cursor = resolved;
      }
      running = true;
      log.info('Ingester started', { cursor, intervalMs });
      timer = setTimeout(() => void tick(), 0);
    },

    stop(): void {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    status(): IngesterStatus {
      return { lastPollAt, lastError, caughtUp };
    },
  };
}
