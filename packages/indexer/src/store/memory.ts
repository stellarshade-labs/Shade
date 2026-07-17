import type {
  AnnouncementRecord,
  AnnouncementStore,
  IngestState,
} from './types.js';

/**
 * In-process {@link AnnouncementStore} (dev fallback). Everything is lost on
 * restart — the factory warns loudly and the ingester re-ingests from
 * INGEST_START. Mutations are synchronous, so a batch is trivially atomic.
 */
export class MemoryAnnouncementStore implements AnnouncementStore {
  private readonly records = new Map<string, AnnouncementRecord>();
  private cursor: string | null = null;
  private startCursor: string | null = null;
  private lastCloseTime: string | null = null;

  async init(): Promise<void> {}

  async insertBatch(
    records: AnnouncementRecord[],
    cursor: string,
    lastCloseTime: string | null,
  ): Promise<void> {
    // Replay-idempotent: an already-present paging_token wins (mirrors the
    // Postgres backend's ON CONFLICT DO NOTHING).
    for (const record of records) {
      if (!this.records.has(record.pagingToken)) {
        this.records.set(record.pagingToken, record);
      }
    }
    this.cursor = cursor;
    this.lastCloseTime = lastCloseTime;
  }

  async getAnnouncements(
    cursor: string | undefined,
    limit: number,
  ): Promise<AnnouncementRecord[]> {
    // Numeric-BigInt ordering: paging_tokens are decimal int64 strings, so
    // '999' < '1000' even though it sorts after lexicographically.
    const after = cursor === undefined ? null : BigInt(cursor);
    return [...this.records.values()]
      .filter((r) => after === null || BigInt(r.pagingToken) > after)
      .sort((a, b) => (BigInt(a.pagingToken) < BigInt(b.pagingToken) ? -1 : 1))
      .slice(0, limit);
  }

  async getIngestState(): Promise<IngestState> {
    return {
      cursor: this.cursor,
      startCursor: this.startCursor,
      lastCloseTime: this.lastCloseTime,
    };
  }

  async setStartCursor(cursor: string): Promise<void> {
    if (this.startCursor === null) this.startCursor = cursor;
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async close(): Promise<void> {}
}
