import type { Pool, PoolClient } from 'pg';
import type {
  AnnouncementRecord,
  AnnouncementStore,
  IngestGap,
  IngestState,
} from './types.js';
import { migrate } from './migrations.js';

/** Shape of an `announcements` row as `pg` marshals it. */
interface AnnouncementRow {
  paging_token: string;
  tx_hash: string;
  memo: string;
  close_time: Date;
  operations: unknown;
  source_account: string | null;
}

/** Shape of an `ingest_gaps` row as `pg` marshals it. */
interface IngestGapRow {
  from_ledger: string;
  to_ledger: string;
  detected_at: Date;
}

/** Shape of the singleton `ingest_state` row as `pg` marshals it. */
interface IngestStateRow {
  cursor: string | null;
  start_cursor: string | null;
  last_close_time: Date | null;
}

/**
 * A durable {@link AnnouncementStore} backed by Postgres.
 *
 * `insertBatch` runs in one transaction so a page's announcements and the
 * cursor/lastCloseTime advance TOGETHER — a crash mid-page replays the whole
 * page (idempotent via the `paging_token` primary key + ON CONFLICT DO
 * NOTHING) instead of skipping announcements. BIGINT columns come back from
 * `pg` as decimal strings, which is exactly the Horizon-interchangeable cursor
 * representation the HTTP layer serves.
 */
export class PostgresAnnouncementStore implements AnnouncementStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Ping the database and apply pending migrations. Call once at boot before
   * serving traffic; a failure should be fatal (never fall back to a
   * different store).
   */
  async init(): Promise<void> {
    await this.pool.query('SELECT 1');
    await migrate(this.pool);
  }

  /**
   * Run `fn` inside a READ COMMITTED transaction on a dedicated connection,
   * committing on success and rolling back on any throw.
   */
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async insertBatch(
    records: AnnouncementRecord[],
    cursor: string,
    lastCloseTime: string | null,
  ): Promise<void> {
    await this.tx(async (client) => {
      for (const record of records) {
        await client.query(
          `INSERT INTO announcements (paging_token, tx_hash, memo, close_time, operations, source_account)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             ON CONFLICT (paging_token) DO NOTHING`,
          [
            record.pagingToken,
            record.hash,
            record.memo,
            record.closeTime,
            JSON.stringify(record.operations),
            record.sourceAccount ?? null,
          ],
        );
      }
      await client.query(
        `INSERT INTO ingest_state (id, cursor, last_close_time)
           VALUES (1, $1, $2)
           ON CONFLICT (id) DO UPDATE
             SET cursor = EXCLUDED.cursor,
                 last_close_time = EXCLUDED.last_close_time,
                 updated_at = now()`,
        [cursor, lastCloseTime],
      );
    });
  }

  async getAnnouncements(
    cursor: string | undefined,
    limit: number,
  ): Promise<AnnouncementRecord[]> {
    // BIGINT comparison is numeric in the database; `$2` is coerced to bigint
    // by the `paging_token > $2` context. ORDER BY must use the QUALIFIED
    // column name: the bare name would resolve to the ::text output alias and
    // sort lexicographically ('999' after '1000').
    const res =
      cursor === undefined
        ? await this.pool.query<AnnouncementRow>(
            `SELECT paging_token::text AS paging_token, tx_hash, memo, close_time, operations, source_account
               FROM announcements ORDER BY announcements.paging_token ASC LIMIT $1`,
            [limit],
          )
        : await this.pool.query<AnnouncementRow>(
            `SELECT paging_token::text AS paging_token, tx_hash, memo, close_time, operations, source_account
               FROM announcements WHERE paging_token > $2
              ORDER BY announcements.paging_token ASC LIMIT $1`,
            [limit, cursor],
          );
    return res.rows.map((row) => ({
      pagingToken: row.paging_token,
      hash: row.tx_hash,
      memo: row.memo,
      closeTime: row.close_time.toISOString(),
      operations: row.operations as unknown[],
      // NULL (pre-migration rows) → undefined, so the record matches the
      // memory backend and JSON serialization drops the field entirely.
      sourceAccount: row.source_account ?? undefined,
    }));
  }

  async getIngestState(): Promise<IngestState> {
    const res = await this.pool.query<IngestStateRow>(
      `SELECT cursor::text AS cursor, start_cursor::text AS start_cursor, last_close_time
         FROM ingest_state WHERE id = 1`,
    );
    const row = res.rows[0];
    if (!row) return { cursor: null, startCursor: null, lastCloseTime: null };
    return {
      cursor: row.cursor,
      startCursor: row.start_cursor,
      lastCloseTime: row.last_close_time
        ? row.last_close_time.toISOString()
        : null,
    };
  }

  async setStartCursor(cursor: string): Promise<void> {
    // Set-once: the conditional DO UPDATE only fires while start_cursor is
    // still NULL, so the first covered feed position is never overwritten.
    await this.pool.query(
      `INSERT INTO ingest_state (id, start_cursor)
         VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE
           SET start_cursor = EXCLUDED.start_cursor, updated_at = now()
           WHERE ingest_state.start_cursor IS NULL`,
      [cursor],
    );
  }

  async recordGap(
    fromLedger: number,
    toLedger: number,
    detectedAt: string,
  ): Promise<void> {
    // Merge-by-fromLedger (see AnnouncementStore.recordGap): the conflict arm
    // only ever WIDENS to_ledger and deliberately leaves detected_at at the
    // first detection time.
    await this.pool.query(
      `INSERT INTO ingest_gaps (from_ledger, to_ledger, detected_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (from_ledger) DO UPDATE
           SET to_ledger = GREATEST(ingest_gaps.to_ledger, EXCLUDED.to_ledger)`,
      [fromLedger, toLedger, detectedAt],
    );
  }

  async getGaps(): Promise<IngestGap[]> {
    // Ledger BIGINTs come back from `pg` as decimal strings; ledger sequences
    // are uint32 so Number() is exact.
    const res = await this.pool.query<IngestGapRow>(
      `SELECT from_ledger, to_ledger, detected_at
         FROM ingest_gaps ORDER BY from_ledger ASC`,
    );
    return res.rows.map((row) => ({
      fromLedger: Number(row.from_ledger),
      toLedger: Number(row.to_ledger),
      detectedAt: row.detected_at.toISOString(),
    }));
  }

  async count(): Promise<number> {
    const res = await this.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM announcements',
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
