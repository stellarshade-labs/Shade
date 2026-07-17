import type { FetchLike, HorizonOp } from './horizon.js';
import { IndexerHttpError, IndexerNetworkError } from './errors.js';

/**
 * Indexer `/health` response. Coverage is the OPEN interval
 * `(startCursor, cursor]` over Horizon's ascending transaction feed: the tx
 * whose paging_token equals `startCursor` is NOT covered (the scan fetches it
 * from Horizon), while everything after it up to `cursor` is.
 */
export interface IndexerHealth {
  status: string;
  network?: string;
  /** Announcement store backend. */
  store?: string;
  /** Feed position fully covered by the indexer; `null` before first ingest. */
  cursor: string | null;
  /** First covered feed position (exclusive); `null` before first ingest. */
  startCursor: string | null;
  /** Close time of the last ingested ledger (ISO timestamp). */
  lastCloseTime?: string | null;
  /** Seconds the indexer lags the network head. */
  lagSeconds?: number | null;
  /** Total announcements held by the store. */
  announcements?: number;
  /** Ingest-loop diagnostics (shape owned by the indexer service). */
  ingest?: unknown;
}

/**
 * One announcement served by the indexer: a successful hash-memo transaction
 * with its operation records inlined VERBATIM (the same `HorizonOp` shapes
 * Horizon's `/transactions/{hash}/operations` returns), so consumers need no
 * per-tx Horizon round-trip.
 */
export interface IndexerAnnouncement {
  hash: string;
  paging_token: string;
  /** base64 32-byte ephemeral key R (Horizon's MemoHash encoding). */
  memo: string;
  memo_type: string;
  successful: boolean;
  created_at?: string;
  /** Verbatim Horizon operation records for this transaction. */
  operations: HorizonOp[];
}

/**
 * Response page from `GET /announcements`. `records` ascend by paging_token
 * and are strictly greater than the request cursor. `cursor` is the position
 * to adopt directly for the next call: the last record's token on a full
 * page, otherwise max(request cursor, indexer global cursor).
 */
export interface AnnouncementsPage {
  records: IndexerAnnouncement[];
  cursor: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Race marker distinguishing a timeout from any value the fetch can produce. */
const TIMED_OUT: unique symbol = Symbol('timed out');

/**
 * Race a promise against a clearable timer (same rationale as relayerPool's
 * helper: the injectable {@link FetchLike} carries no abort signal, and a
 * plain `setTimeout` stays visible to vitest's fake timers). The losing
 * promise keeps running; its rejection is swallowed by the detached guard.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  void promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Thin HTTP client for the announcement indexer service — the account
 * method's discovery accelerator. Horizon remains the source of truth: every
 * failure here surfaces as a typed error the scan treats as "fall back to the
 * Horizon walk", never as a lost payment.
 *
 * Transport failures and timeouts throw {@link IndexerNetworkError}; non-2xx
 * responses throw {@link IndexerHttpError} carrying the HTTP status and the
 * indexer's `{ error, code }` body code.
 *
 * @example
 * ```typescript
 * const indexer = new IndexerClient('http://localhost:4000');
 * const { cursor } = await indexer.health();
 * ```
 */
export class IndexerClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  /**
   * @param baseUrl - Indexer root URL (no trailing slash required).
   * @param fetchFn - Injectable fetch (defaults to the global `fetch`).
   * @param opts - Optional per-request timeout in ms (default 10000).
   */
  constructor(
    baseUrl: string,
    fetchFn?: FetchLike,
    opts?: { timeoutMs?: number },
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async get<T>(path: string): Promise<T> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      const raced = await withTimeout(
        this.fetchFn(`${this.baseUrl}${path}`),
        this.timeoutMs,
      );
      if (raced === TIMED_OUT) {
        throw new IndexerNetworkError(
          path,
          `request timed out after ${this.timeoutMs}ms`,
        );
      }
      res = raced;
    } catch (err) {
      if (err instanceof IndexerNetworkError) throw err;
      throw new IndexerNetworkError(
        path,
        err instanceof Error ? err.message : String(err),
      );
    }
    return this.decode<T>(path, res);
  }

  /**
   * Decode an indexer response. A non-JSON body on an error status (e.g. a
   * proxy's HTML 502 page) must not mask the status, so decode failures fall
   * back to an empty body there; a non-JSON body on a 2xx is a broken indexer
   * and surfaces as a transport error.
   */
  private async decode<T>(
    path: string,
    res: Awaited<ReturnType<FetchLike>>,
  ): Promise<T> {
    let data: (T & { error?: string; code?: string }) | undefined;
    try {
      data = (await res.json()) as T & { error?: string; code?: string };
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      throw new IndexerHttpError(path, res.status, data?.code, data?.error);
    }
    if (data === undefined) {
      throw new IndexerNetworkError(path, 'invalid JSON response body');
    }
    return data as T;
  }

  /** Probe the indexer's health and coverage window. */
  async health(): Promise<IndexerHealth> {
    return this.get<IndexerHealth>('/health');
  }

  /**
   * Fetch one page of announcements strictly after `cursor` (omit for the
   * start of coverage).
   *
   * @param cursor - Feed position to resume from (records returned are > it).
   * @param limit - Page size (the service caps it at 200).
   * @returns The page's records plus the cursor to adopt for the next call.
   */
  async getAnnouncements(
    cursor?: string,
    limit?: number,
  ): Promise<AnnouncementsPage> {
    const params = new URLSearchParams();
    if (cursor !== undefined) params.set('cursor', cursor);
    if (limit !== undefined) params.set('limit', String(limit));
    const query = params.toString();
    return this.get<AnnouncementsPage>(
      `/announcements${query ? `?${query}` : ''}`,
    );
  }
}
