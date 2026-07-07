/**
 * Minimal Horizon REST helper with an injectable `fetch`.
 *
 * The account delivery method relies only on Horizon's classic REST API
 * (transaction paging + operations + account probe + submit). Keeping this in a
 * tiny, dependency-free wrapper with an injectable fetch makes the account
 * scanner unit-testable fully offline: tests pass a stub fetch returning
 * synthetic fixtures, no docker network required.
 */

/** A subset of a Horizon transaction record relevant to the account method. */
export interface HorizonTx {
  id: string;
  hash: string;
  paging_token: string;
  memo_type: string;
  memo?: string;
  successful?: boolean;
  /** The account that submitted (and pays for) the transaction. */
  source_account?: string;
}

/**
 * A CAP-23 claim predicate as Horizon serializes it. A missing/`unconditional`
 * predicate is always claimable; the time-bounded variants are evaluated
 * against ledger time so an unsatisfiable CB is not reported as income.
 */
export interface HorizonPredicate {
  unconditional?: boolean;
  and?: HorizonPredicate[];
  or?: HorizonPredicate[];
  not?: HorizonPredicate;
  /** RFC-3339 timestamp: claimable strictly BEFORE this absolute time. */
  abs_before?: string;
  /** Same bound as an epoch-seconds string (Horizon includes both). */
  abs_before_epoch?: string;
  /** Seconds since the CB was created after which it becomes claimable. */
  rel_before?: string;
}

/** A single claimant on a create_claimable_balance operation. */
export interface HorizonClaimant {
  destination: string;
  predicate?: HorizonPredicate;
}

/** A subset of a Horizon operation record relevant to the account method. */
export interface HorizonOp {
  id: string;
  type: string;
  transaction_hash: string;
  /** create_account: the newly created account */
  account?: string;
  /** create_account: starting balance (string, whole units) */
  starting_balance?: string;
  /** payment: destination account */
  to?: string;
  /** payment: amount (string, whole units) */
  amount?: string;
  /** payment / create_claimable_balance: asset type ('native' for XLM) */
  asset_type?: string;
  /** create_claimable_balance: asset in "CODE:ISSUER" form (or 'native') */
  asset?: string;
  /** create_claimable_balance: the claimants list */
  claimants?: HorizonClaimant[];
}

/** A Horizon claimable-balance record (used by the token account method). */
export interface HorizonClaimableBalance {
  id: string;
  asset: string;
  amount: string;
  sponsor?: string;
  claimants: HorizonClaimant[];
}

/** Horizon account record subset (used to probe existence + sequence). */
export interface HorizonAccount {
  id: string;
  sequence: string;
  balances: Array<{ asset_type: string; balance: string }>;
}

/** Injectable fetch signature (compatible with the global `fetch`). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface HorizonPage<T> {
  _embedded?: { records?: T[] };
}

/** A thin, injectable-fetch Horizon REST client. */
export class HorizonClient {
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

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`Horizon GET ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Page transactions in ascending order.
   *
   * @param cursor - Paging token to resume from (omit for the beginning).
   * @param limit - Page size (default 200, Horizon's max).
   * @returns The page's transaction records (may be empty).
   */
  async getTransactions(cursor?: string, limit = 200): Promise<HorizonTx[]> {
    const params = new URLSearchParams({
      order: 'asc',
      limit: String(limit),
    });
    if (cursor) params.set('cursor', cursor);
    const page = await this.getJson<HorizonPage<HorizonTx>>(
      `/transactions?${params.toString()}`,
    );
    return page._embedded?.records ?? [];
  }

  /**
   * Fetch the operations belonging to a single transaction.
   *
   * @param txHash - Transaction hash.
   * @returns The transaction's operation records.
   */
  async getTransactionOperations(txHash: string): Promise<HorizonOp[]> {
    const page = await this.getJson<HorizonPage<HorizonOp>>(
      `/transactions/${txHash}/operations?limit=200`,
    );
    return page._embedded?.records ?? [];
  }

  /**
   * Probe an account. Returns null if the account does not exist (404).
   *
   * @param address - Stellar G-address.
   */
  async getAccount(address: string): Promise<HorizonAccount | null> {
    const res = await this.fetchFn(`${this.baseUrl}/accounts/${address}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon GET account failed: ${res.status}`);
    return (await res.json()) as HorizonAccount;
  }

  /**
   * List claimable balances for which the given address is a claimant.
   *
   * Used by the token account method: a direct token send lands as a
   * CreateClaimableBalance to the derived stealth address, which the recipient
   * later claims. Returns an empty array when the account has none.
   *
   * @param claimant - Stellar G-address to filter claimable balances by.
   */
  async getClaimableBalances(
    claimant: string,
  ): Promise<HorizonClaimableBalance[]> {
    const page = await this.getJson<HorizonPage<HorizonClaimableBalance>>(
      `/claimable_balances?claimant=${claimant}&limit=200`,
    );
    return page._embedded?.records ?? [];
  }

  /**
   * Submit a base64 transaction envelope XDR to Horizon.
   *
   * @param xdr - base64-encoded transaction envelope.
   * @returns The submitted transaction hash.
   */
  async submitTransaction(xdr: string): Promise<{ hash: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `tx=${encodeURIComponent(xdr)}`,
    });
    const body = (await res.json()) as {
      hash?: string;
      extras?: { result_codes?: unknown };
    };
    if (!res.ok || !body.hash) {
      throw new Error(
        `Horizon submit failed: ${JSON.stringify(body.extras?.result_codes ?? res.status)}`,
      );
    }
    return { hash: body.hash };
  }
}
