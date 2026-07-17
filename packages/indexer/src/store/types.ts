/**
 * One indexed announcement candidate: a hash-memo transaction whose MemoHash
 * IS the ephemeral pubkey R of a Shade account-method payment.
 */
export interface AnnouncementRecord {
  /** Horizon paging_token — a decimal int64 TOID string. */
  pagingToken: string;
  /** Transaction hash (hex). */
  hash: string;
  /** MemoHash as Horizon serves it: base64 of the 32-byte R. */
  memo: string;
  /** Transaction close time (ISO timestamp). */
  closeTime: string;
  /**
   * VERBATIM Horizon operation records — never projected down to a subset of
   * fields, because the SDK consumes them as HorizonOp and re-derives the
   * stealth address from R + the operation payload.
   */
  operations: unknown[];
  /**
   * Transaction-level source account, enabling the SDK's sponsor-precise
   * claimable-balance binding. Absent on rows ingested before the field
   * existed.
   */
  sourceAccount?: string;
}

/**
 * A range of ledgers the ingester can never cover: Horizon's retention window
 * advanced past the ingest cursor, so `[fromLedger, toLedger]` (inclusive) was
 * dropped by Horizon before it was ingested. Surfaced via /health so clients
 * fall back to Horizon for correctness.
 */
export interface IngestGap {
  fromLedger: number;
  toLedger: number;
  /** When the hole was FIRST detected (ISO timestamp). */
  detectedAt: string;
}

/** Persisted ingest progress (all Horizon paging_tokens as decimal strings). */
export interface IngestState {
  /** Last covered feed position (null on a fresh store). */
  cursor: string | null;
  /** First covered feed position, recorded once at first ingest. */
  startCursor: string | null;
  /** Close time of the last covered transaction (ISO), null when unknown. */
  lastCloseTime: string | null;
}

/**
 * Durable announcement storage. Implementations: in-process memory (dev
 * fallback) and Postgres (durable). All cursors are Horizon paging_tokens
 * compared NUMERICALLY (int64), never lexicographically.
 */
export interface AnnouncementStore {
  init(): Promise<void>;
  /**
   * Atomically persist a page's announcements AND advance the ingest cursor +
   * lastCloseTime together (one transaction). Called with `records = []`
   * purely to advance the cursor. Idempotent on replay: an already-present
   * paging_token is skipped (ON CONFLICT DO NOTHING semantics).
   */
  insertBatch(
    records: AnnouncementRecord[],
    cursor: string,
    lastCloseTime: string | null,
  ): Promise<void>;
  /**
   * Announcements with pagingToken strictly greater than `cursor` (numeric
   * compare), ascending, at most `limit` rows. `cursor === undefined` reads
   * from the beginning of what the store has.
   */
  getAnnouncements(
    cursor: string | undefined,
    limit: number,
  ): Promise<AnnouncementRecord[]>;
  getIngestState(): Promise<IngestState>;
  /** Record the first covered feed position ONCE (no-op if already set). */
  setStartCursor(cursor: string): Promise<void>;
  /**
   * Record an unservable ledger range. Gaps are keyed by `fromLedger`:
   * recording an existing `fromLedger` extends `toLedger` to the max of
   * old/new and KEEPS the first `detectedAt` — a stalled cursor re-detects a
   * widening hole as Horizon retention advances, and merging keeps one honest
   * row instead of accumulating near-duplicates.
   */
  recordGap(
    fromLedger: number,
    toLedger: number,
    detectedAt: string,
  ): Promise<void>;
  /** All recorded gaps, ordered by `fromLedger` ascending. */
  getGaps(): Promise<IngestGap[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}
