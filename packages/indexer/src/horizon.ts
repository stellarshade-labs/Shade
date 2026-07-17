/**
 * Minimal Horizon REST helper with an injectable `fetch` (same pattern as the
 * SDK's FetchLike). Self-contained on purpose — the indexer depends on neither
 * @shade/sdk nor @stellar/stellar-sdk. Keeping the client tiny and injectable
 * makes the ingester unit-testable fully offline: tests pass a stub returning
 * synthetic fixtures, no network required.
 */

/** Injectable fetch signature (compatible with the global `fetch`). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The subset of a Horizon transaction record the ingester reads. */
export interface HorizonTxRecord {
  paging_token: string;
  hash: string;
  memo_type: string;
  memo?: string;
  successful?: boolean;
  created_at: string;
  /** Transaction-level source account (Horizon serves it on every tx record). */
  source_account?: string;
}

interface HorizonPage<T> {
  _embedded?: { records?: T[] };
}

/** The feed surface the ingester consumes (stubbed in tests). */
export interface HorizonFeed {
  getTransactions(
    cursor: string | undefined,
    limit: number,
  ): Promise<HorizonTxRecord[]>;
  getLatestTransactionToken(): Promise<string | undefined>;
  getOperations(txHash: string): Promise<unknown[]>;
  /**
   * Horizon's retention window, for the ingester's feed continuity check:
   * `elderLedger` is the oldest ledger this Horizon can still serve,
   * `latestLedger` the newest it has ingested. A field is omitted when Horizon
   * does not report it, so callers can tell "unknown" from a real bound.
   */
  getFeedLedgerBounds(): Promise<{
    elderLedger?: number;
    latestLedger?: number;
    /** The root document's network_passphrase, when it reports one. */
    networkPassphrase?: string;
  }>;
}

/** A thin, injectable-fetch Horizon REST client. */
export class HorizonClient implements HorizonFeed {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  /**
   * @param baseUrl - Horizon root URL (no trailing slash required).
   * @param fetchFn - Injectable fetch (defaults to the global `fetch`).
   */
  constructor(baseUrl: string, fetchFn?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** Non-2xx → throw including the status; a JSON parse failure also throws. */
  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`Horizon GET ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Page the global transaction feed in ascending order. */
  async getTransactions(
    cursor: string | undefined,
    limit: number,
  ): Promise<HorizonTxRecord[]> {
    const params = new URLSearchParams({ order: 'asc', limit: String(limit) });
    if (cursor !== undefined) params.set('cursor', cursor);
    const page = await this.getJson<HorizonPage<HorizonTxRecord>>(
      `/transactions?${params.toString()}`,
    );
    return page._embedded?.records ?? [];
  }

  /** The paging_token of the newest transaction (undefined on an empty network). */
  async getLatestTransactionToken(): Promise<string | undefined> {
    const page = await this.getJson<HorizonPage<HorizonTxRecord>>(
      '/transactions?order=desc&limit=1',
    );
    return page._embedded?.records?.[0]?.paging_token;
  }

  /**
   * A transaction's operation records, VERBATIM. One page suffices: the
   * protocol caps operations per transaction at 100, below the 200 limit.
   */
  async getOperations(txHash: string): Promise<unknown[]> {
    const page = await this.getJson<HorizonPage<unknown>>(
      `/transactions/${txHash}/operations?limit=200`,
    );
    return page._embedded?.records ?? [];
  }

  /** Retention bounds from the Horizon root document (see {@link HorizonFeed}). */
  async getFeedLedgerBounds(): Promise<{
    elderLedger?: number;
    latestLedger?: number;
    networkPassphrase?: string;
  }> {
    const root = await this.getJson<{
      history_elder_ledger?: unknown;
      history_latest_ledger?: unknown;
      network_passphrase?: unknown;
    }>('/');
    const bounds: {
      elderLedger?: number;
      latestLedger?: number;
      networkPassphrase?: string;
    } = {};
    if (
      typeof root.history_elder_ledger === 'number' &&
      Number.isFinite(root.history_elder_ledger)
    ) {
      bounds.elderLedger = root.history_elder_ledger;
    }
    if (
      typeof root.history_latest_ledger === 'number' &&
      Number.isFinite(root.history_latest_ledger)
    ) {
      bounds.latestLedger = root.history_latest_ledger;
    }
    if (typeof root.network_passphrase === 'string') {
      bounds.networkPassphrase = root.network_passphrase;
    }
    return bounds;
  }
}
