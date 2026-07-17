import { Request, Response } from 'express';
import type { AnnouncementStore } from '../store/types.js';
import type { IngesterStatus } from '../ingest.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** Larger of two decimal int64 tokens (numeric BigInt compare, never lexicographic). */
function maxToken(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** What the health endpoint needs from boot: static labels + live state. */
export interface HealthDeps {
  network: string;
  storeKind: 'postgres' | 'memory';
  store: AnnouncementStore;
  ingestStatus(): IngesterStatus;
}

/** GET /health — ingest progress, lag, and backend transparency. */
export function createHealthHandler(deps: HealthDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const state = await deps.store.getIngestState();
    const announcements = await deps.store.count();
    const ingest = deps.ingestStatus();
    const lagSeconds =
      state.lastCloseTime === null
        ? null
        : Math.round((Date.now() - Date.parse(state.lastCloseTime)) / 1000);
    res.json({
      status: 'ok',
      network: deps.network,
      store: deps.storeKind,
      cursor: state.cursor,
      startCursor: state.startCursor,
      lastCloseTime: state.lastCloseTime,
      lagSeconds,
      announcements,
      ingest: { lastPollAt: ingest.lastPollAt, lastError: ingest.lastError },
    });
  };
}

/**
 * GET /announcements?cursor=&limit= — the compact candidate feed.
 *
 * Records are shaped like Horizon transaction records (memo_type 'hash',
 * successful true, operations verbatim) and cursors ARE Horizon paging_tokens,
 * so a client can swap between indexer and Horizon without translating state.
 * Deliberately no address- or R-keyed filter: any such query would let the
 * operator link keys to requests — clients filter locally.
 *
 * Response cursor rule: a FULL page returns the last row's token (come back
 * for more); a drained page returns max(request cursor, indexer's global
 * ingest cursor) so a caught-up caller jumps its cursor to the indexer's
 * position instead of re-walking covered ledger.
 */
export function createAnnouncementsHandler(store: AnnouncementStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawCursor = req.query.cursor;
    let cursor: string | undefined;
    if (rawCursor !== undefined) {
      if (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor)) {
        res.status(400).json({
          error: 'cursor must be a decimal Horizon paging token',
          code: 'invalid_cursor',
        });
        return;
      }
      cursor = rawCursor;
    }

    const rawLimit = req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (typeof rawLimit === 'string' && rawLimit.trim() !== '') {
      const parsed = Number.parseInt(rawLimit, 10);
      if (Number.isFinite(parsed)) limit = parsed;
    }
    limit = Math.max(1, Math.min(MAX_LIMIT, limit));

    const rows = await store.getAnnouncements(cursor, limit);
    const records = rows.map((row) => ({
      hash: row.hash,
      paging_token: row.pagingToken,
      memo: row.memo,
      memo_type: 'hash',
      successful: true,
      created_at: row.closeTime,
      operations: row.operations,
    }));

    let nextCursor: string;
    if (rows.length === limit) {
      nextCursor = rows[rows.length - 1]!.pagingToken;
    } else {
      const state = await store.getIngestState();
      nextCursor = maxToken(cursor ?? '0', state.cursor ?? '0');
    }
    res.json({ records, cursor: nextCursor });
  };
}
