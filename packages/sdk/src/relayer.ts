import { Transaction } from '@stellar/stellar-sdk';
import type { FetchLike } from './horizon.js';
import { waitForTransaction, type TransactionStatusSource } from './soroban.js';

/**
 * Signs a canonical challenge message with the funding account's ed25519 key,
 * proving control of that account for a fee-spending relayer request. Returns
 * the signature as base64 or hex (or raw bytes). Kept abstract so an app can
 * back it by a wallet, an HSM, or a raw secret key without the SDK ever holding
 * the funding key.
 */
export type FundingSigner = (
  message: string,
) => Promise<Uint8Array | string> | Uint8Array | string;

/** Response from `GET /credit/challenge`. */
export interface CreditChallenge {
  account: string;
  nonce: string;
}

/**
 * Canonical single-line message the funding account signs to authorize a spend.
 * MUST match the relayer's `challengeMessage` byte-for-byte. When `bind` is
 * supplied (e.g. the inner-tx hash on the `/relay` path) it is appended so the
 * signature is pinned to that specific transaction and cannot be paired with a
 * different attacker-signed inner XDR of the same amount.
 */
export function challengeMessage(
  endpoint: string,
  fundingAccount: string,
  nonce: string,
  amount: string,
  bind?: string,
): string {
  const base = `shade-relayer:v1:${endpoint}:${fundingAccount}:${nonce}:${amount}`;
  return bind ? `${base}:${bind}` : base;
}

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
  /** Signer proving control of `fundingAccount` (credit-gated relayers). */
  fundingSigner?: FundingSigner;
  /**
   * The fee/amount (7-dp XLM string) the proof-of-control signature authorizes.
   * MUST equal the fee the relayer will charge, or the relayer rejects with 401.
   */
  authAmount?: string;
  /**
   * Network passphrase used to compute the inner-tx hash bound into the
   * proof-of-control signature. MUST match the passphrase the relayer verifies
   * under, or a credit-gated relayer rejects with 401. Required to bind the
   * inner tx on a credit-gated `/relay`; omit for the free/default path.
   */
  networkPassphrase?: string;
  /**
   * Do not trust the relayer's returned txHash at face value: poll it to a
   * terminal on-chain status before resolving (SDK-TXHASH-TRUST). Requires an
   * `rpcServer` in the {@link RelayerClient} constructor opts. Throws
   * `TransactionTimeoutError` (carrying the txHash) if the poll window closes
   * while the tx is still unseen/pending, or an error if it FAILED on-chain.
   * Default `false`: resolve as soon as the relayer responds, exactly as before.
   */
  confirm?: boolean;
}

/** Options for {@link RelayerClient.sponsor}. */
export interface SponsorOpts {
  /** Starting balance for the newly created account (whole XLM). */
  startingBalance?: string;
  /** App account to debit against (credit-gated relayers). */
  fundingAccount?: string;
  /** Signer proving control of `fundingAccount` (credit-gated relayers). */
  fundingSigner?: FundingSigner;
  /**
   * The total (startingBalance + fee, 7-dp XLM string) the proof-of-control
   * signature authorizes. MUST equal what the relayer will charge.
   */
  authAmount?: string;
}

/** Arguments for {@link RelayerClient.sponsorClaimPrepare}. */
export interface SponsorClaimPrepareArgs {
  /** The stealth address that will claim the balance. */
  stealthAddress: string;
  /** Asset to add a trustline for, in "CODE:ISSUER" form. */
  asset: string;
  /** Claimable balance id to claim. */
  balanceId: string;
  /** Destination that the claimed token is paid out to (must trust the asset). */
  destination: string;
  /** Amount of the claimed token to pay out to the destination (7-dp string). */
  amount: string;
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
  private readonly fundingSigner?: FundingSigner;
  private readonly fundingAccount?: string;
  private readonly rpcServer?: TransactionStatusSource;

  /**
   * @param baseUrl - Relayer root URL. A trailing `/relay` is stripped so a
   *   bare relay URL (back-compat) resolves to the service root.
   * @param fetchFn - Injectable fetch (defaults to the global `fetch`).
   * @param opts - Optional default `fundingAccount` + `fundingSigner` used to
   *   authenticate fee-spending requests against a credit-gated relayer, and
   *   an optional `rpcServer` (an `rpc.Server`, or any object with its
   *   `getTransaction`) used to confirm-poll returned tx hashes when a call
   *   sets `confirm: true`.
   */
  constructor(
    baseUrl: string,
    fetchFn?: FetchLike,
    opts?: {
      fundingAccount?: string;
      fundingSigner?: FundingSigner;
      rpcServer?: TransactionStatusSource;
    },
  ) {
    this.baseUrl = baseUrl.replace(/\/relay\/?$/, '').replace(/\/$/, '');
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.fundingAccount = opts?.fundingAccount;
    this.fundingSigner = opts?.fundingSigner;
    this.rpcServer = opts?.rpcServer;
  }

  /**
   * Poll a relayer-returned txHash until it lands on-chain (SDK-TXHASH-TRUST).
   * A relayer could return a fabricated or failed hash with a 200; polling to a
   * terminal status is what turns "the relayer said so" into "the chain says
   * so". Deliberately loud when no poll handle exists — silently skipping the
   * confirmation a caller asked for would defeat its purpose. On timeout the
   * underlying `waitForTransaction` throws `TransactionTimeoutError` carrying
   * the txHash, so the caller can keep polling instead of blindly resubmitting.
   */
  private async confirmOnChain(txHash: string): Promise<void> {
    if (!this.rpcServer) {
      throw new Error(
        'confirm: true requires an RPC handle: pass opts.rpcServer (an rpc.Server ' +
          'for the same network) to the RelayerClient constructor.',
      );
    }
    await waitForTransaction(this.rpcServer, txHash);
  }

  /**
   * Fetch a fresh challenge nonce for `fundingAccount`, sign the canonical
   * message binding `endpoint` + account + nonce + `amount`, and return the
   * `{ fundingAccount, nonce, signature }` to attach to a fee-spending request.
   * Returns `undefined` when no signer is available (non-gated relayer path).
   */
  private async signedAuth(
    endpoint: string,
    fundingAccount: string | undefined,
    signer: FundingSigner | undefined,
    amount: string | undefined,
    bind?: string,
  ): Promise<{ nonce: string; signature: string } | undefined> {
    const account = fundingAccount ?? this.fundingAccount;
    const fundingSigner = signer ?? this.fundingSigner;
    if (!account || !fundingSigner) return undefined;
    const authAmount = amount ?? '0';
    const { nonce } = await this.get<CreditChallenge>(
      `/credit/challenge?account=${encodeURIComponent(account)}`,
    );
    const message = challengeMessage(endpoint, account, nonce, authAmount, bind);
    const raw = await fundingSigner(message);
    const signature =
      typeof raw === 'string' ? raw : Buffer.from(raw).toString('base64');
    return { nonce, signature };
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
   * @param opts - Optional funding account to debit the fee against, and
   *   `confirm` to poll the returned hash to an on-chain terminal status.
   * @returns The submitted transaction hash.
   */
  async relay(xdr: string, opts?: RelayOpts): Promise<{ txHash: string }> {
    const fundingAccount = opts?.fundingAccount ?? this.fundingAccount;
    // Bind the inner-tx hash into the proof-of-control signature so a captured
    // {nonce, signature} cannot be paired with a different inner XDR (REL-01
    // tx-binding). MUST use the same network passphrase the relayer verifies
    // under; only computable when a passphrase is supplied.
    const innerTxHash = opts?.networkPassphrase
      ? new Transaction(xdr, opts.networkPassphrase).hash().toString('hex')
      : undefined;
    const auth = await this.signedAuth(
      'relay',
      fundingAccount,
      opts?.fundingSigner,
      opts?.authAmount,
      innerTxHash,
    );
    const result = await this.post<{ txHash: string }>('/relay', {
      xdr,
      fundingAccount,
      ...(auth ?? {}),
    });
    if (opts?.confirm) {
      await this.confirmOnChain(result.txHash);
    }
    return result;
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
    const fundingAccount = opts?.fundingAccount ?? this.fundingAccount;
    const auth = await this.signedAuth(
      'sponsor',
      fundingAccount,
      opts?.fundingSigner,
      opts?.authAmount,
    );
    return this.post<{ txHash: string }>('/sponsor', {
      address,
      startingBalance: opts?.startingBalance,
      fundingAccount,
      ...(auth ?? {}),
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
   *   `confirm: true` polls the returned hash to an on-chain terminal status
   *   (requires `rpcServer` in the constructor opts).
   */
  async sponsorClaimSubmit(
    xdr: string,
    args: {
      stealthAddress: string;
      asset: string;
      balanceId: string;
      destination: string;
      amount: string;
      fundingAccount?: string;
      fundingSigner?: FundingSigner;
      /** Total (reserve + fee) the proof-of-control signature authorizes. */
      authAmount?: string;
      /** Poll the returned txHash until it lands on-chain (see {@link RelayOpts.confirm}). */
      confirm?: boolean;
    },
  ): Promise<{ txHash: string }> {
    const fundingAccount = args.fundingAccount ?? this.fundingAccount;
    const auth = await this.signedAuth(
      'sponsor-claim',
      fundingAccount,
      args.fundingSigner,
      args.authAmount,
    );
    const result = await this.post<{ txHash: string }>('/sponsor-claim/submit', {
      xdr,
      stealthAddress: args.stealthAddress,
      asset: args.asset,
      balanceId: args.balanceId,
      destination: args.destination,
      amount: args.amount,
      fundingAccount,
      ...(auth ?? {}),
    });
    if (args.confirm) {
      await this.confirmOnChain(result.txHash);
    }
    return result;
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
