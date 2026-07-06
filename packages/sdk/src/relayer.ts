import type { FetchLike } from './horizon.js';

/** Relayer `/health` response. */
export interface RelayerHealth {
  status: string;
  network?: string;
  relayerAddress?: string;
  balance?: string;
}

/** Options for {@link RelayerClient.relay}. */
export interface RelayOpts {
  /** App account to debit the fee-bump fee against (credit-gated relayers). */
  fundingAccount?: string;
}

/** Options for {@link RelayerClient.sponsor}. */
export interface SponsorOpts {
  /** Starting balance for the newly created account (whole XLM). */
  startingBalance?: string;
  /** App account to debit against (credit-gated relayers). */
  fundingAccount?: string;
}

/** Arguments for {@link RelayerClient.sponsorClaimPrepare}. */
export interface SponsorClaimPrepareArgs {
  /** The stealth address that will claim the balance. */
  stealthAddress: string;
  /** Asset to add a trustline for, in "CODE:ISSUER" form. */
  asset: string;
  /** Claimable balance id to claim (optional at prepare time). */
  balanceId?: string;
}

/** Response from {@link RelayerClient.sponsorClaimPrepare}. */
export interface SponsorClaimPrepared {
  /** Unsigned transaction XDR for the client to co-sign with the stealth key. */
  xdr: string;
  /** ISO timestamp after which the prepared tx's timebounds expire. */
  expiresAt: string;
}

/** A read-only credit-ledger view for an app funding account. */
export interface CreditView {
  fundingAccount: string;
  balance: string;
  updatedAt?: string;
}

/**
 * Thin HTTP client for the reserve relayer service. Every fee-spending endpoint
 * is exposed as a typed method so the SDK (and apps) never hand-roll fetch calls
 * or URL joining. Construct once and reuse.
 *
 * @example
 * ```typescript
 * const relayer = new RelayerClient('http://localhost:3000');
 * const { status } = await relayer.health();
 * ```
 */
export class RelayerClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  /**
   * @param baseUrl - Relayer root URL. A trailing `/relay` is stripped so a
   *   bare relay URL (back-compat) resolves to the service root.
   * @param fetchFn - Injectable fetch (defaults to the global `fetch`).
   */
  constructor(baseUrl: string, fetchFn?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/relay\/?$/, '').replace(/\/$/, '');
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string; code?: string };
    if (!res.ok) {
      throw new Error(
        `Relayer ${path} failed (${res.status}): ${data.code ?? data.error ?? 'unknown'}`,
      );
    }
    return data as T;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    const data = (await res.json()) as T & { error?: string; code?: string };
    if (!res.ok) {
      throw new Error(
        `Relayer ${path} failed (${res.status}): ${data.code ?? data.error ?? 'unknown'}`,
      );
    }
    return data as T;
  }

  /** Probe the relayer's health, balance, and address. */
  async health(): Promise<RelayerHealth> {
    return this.get<RelayerHealth>('/health');
  }

  /**
   * Fee-bump and submit a signed transaction envelope.
   *
   * @param xdr - base64 signed transaction envelope.
   * @param opts - Optional funding account to debit the fee against.
   * @returns The submitted transaction hash.
   */
  async relay(xdr: string, opts?: RelayOpts): Promise<{ txHash: string }> {
    return this.post<{ txHash: string }>('/relay', {
      xdr,
      fundingAccount: opts?.fundingAccount,
    });
  }

  /**
   * Create a stealth account from the relayer's own balance (funded
   * CreateAccount — no sponsorship sandwich).
   *
   * @param address - Stealth G-address to create.
   * @param opts - Starting balance and optional funding account.
   */
  async sponsor(
    address: string,
    opts?: SponsorOpts,
  ): Promise<{ txHash: string }> {
    return this.post<{ txHash: string }>('/sponsor', {
      address,
      startingBalance: opts?.startingBalance,
      fundingAccount: opts?.fundingAccount,
    });
  }

  /**
   * Ask the relayer to build the sponsored claimable-balance-claim transaction.
   * Returns UNSIGNED XDR the client must co-sign with the stealth key before
   * calling {@link sponsorClaimSubmit}.
   */
  async sponsorClaimPrepare(
    args: SponsorClaimPrepareArgs,
  ): Promise<SponsorClaimPrepared> {
    return this.post<SponsorClaimPrepared>('/sponsor-claim/prepare', args);
  }

  /**
   * Submit a sponsor-claim transaction the client has co-signed. The relayer
   * re-derives the expected operations from the trusted inputs
   * (`stealthAddress`, `asset`, `balanceId`) and verifies the submitted ops
   * match field-by-field before adding its signature and submitting.
   *
   * @param xdr - The stealth-co-signed transaction XDR.
   * @param args - The trusted claim inputs (and optional funding account).
   */
  async sponsorClaimSubmit(
    xdr: string,
    args: {
      stealthAddress: string;
      asset: string;
      balanceId: string;
      fundingAccount?: string;
    },
  ): Promise<{ txHash: string }> {
    return this.post<{ txHash: string }>('/sponsor-claim/submit', {
      xdr,
      stealthAddress: args.stealthAddress,
      asset: args.asset,
      balanceId: args.balanceId,
      fundingAccount: args.fundingAccount,
    });
  }

  /**
   * Report a completed on-chain deposit to the relayer so it credits the app's
   * funding account with the paid amount.
   */
  async creditClaim(
    fundingAccount: string,
    txHash: string,
  ): Promise<CreditView> {
    return this.post<CreditView>('/credit/claim', { fundingAccount, txHash });
  }

  /** Read the current credit balance for an app funding account. */
  async creditBalance(fundingAccount: string): Promise<CreditView> {
    return this.get<CreditView>(`/credit/${fundingAccount}`);
  }
}
