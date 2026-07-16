/**
 * A delivery method describes HOW a stealth payment reaches its recipient.
 * - `'pool'`  — deposit into the Soroban pool contract (default, private, any SAC token).
 * - `'account'` — a direct classic Stellar payment that creates/pays a one-time stealth
 *   account, with the ephemeral key carried in a MemoHash. Native XLM only for now.
 * - `'spp'` — reserved slot for a future Stellar Private Payments (ZK shielded pool) integration.
 */
export type DeliveryMethod = 'pool' | 'account' | 'spp';

/**
 * An external transaction signer, shaped like Freighter's `signTransaction`.
 *
 * Takes an UNSIGNED transaction XDR and returns a SIGNED transaction XDR. This
 * lets a browser wallet (e.g. Freighter) sign the SENDER and FEE-PAYER legs of
 * an SDK transaction so a dapp never touches a raw Stellar secret. The recovered
 * stealth-key legs still sign locally — a wallet cannot hold the derived stealth
 * scalar — so a signer is only ever applied to the sender / fee-payer legs.
 *
 * @param xdr - The unsigned transaction XDR (base64).
 * @param opts - Network passphrase and, optionally, the G-address expected to
 *   sign (the public key the caller passed where a secret normally goes).
 * @returns The signed transaction XDR (base64).
 */
export type TransactionSigner = (
  xdr: string,
  opts: { networkPassphrase: string; address?: string },
) => Promise<string>;

/** Stealth key material. All keys are hex-encoded strings for easy serialization. */
export interface StealthKeys {
  /** Meta-address string (shade:stellar:...) — share this publicly */
  metaAddress: string;
  /** Spend public key (hex) */
  spendPubKey: string;
  /** Spend private key (hex) — NEVER share */
  spendPrivKey: string;
  /** View public key (hex) */
  viewPubKey: string;
  /** View private key (hex) — safe to share with scanning services */
  viewPrivKey: string;
}

/** Receipt returned after a successful deposit. */
export interface SendReceipt {
  /** The one-time stealth address funds were sent to */
  stealthAddress: string;
  /** Transaction hash */
  txHash: string;
}

/** A detected stealth payment found during scanning. */
export interface Payment {
  /** The stealth address holding the funds */
  stealthAddress: string;
  /** Ephemeral public key from the announcement/memo (hex) */
  ephemeralPubKey: string;
  /**
   * Token identifier — tri-modal, depending on how the payment arrived:
   * - pool method: the SAC token CONTRACT address (`C...`);
   * - account method, native send: the literal string `'native'`;
   * - account method, token send: Horizon's `"CODE:ISSUER"` form.
   */
  token: string;
  /**
   * Human-oriented asset label. Set on EVERY pool payment (`'XLM'` for the
   * native SAC, otherwise the `C...` address — see `labelForToken`) and on
   * account-method token payments (`"CODE:ISSUER"`, from the claimable
   * balance). Absent only on account-method NATIVE payments, where
   * {@link token} is already `'native'`.
   */
  asset?: string;
  /**
   * Claimable balance id (account-method token payments only). Its presence is
   * what marks a payment as a token claim rather than a plain XLM send.
   */
  claimableBalanceId?: string;
  /** Amount in whole units (e.g. 100.0 = 100 XLM) */
  amount: number;
  /**
   * Exact amount as a decimal `bigint` count of stroops (1e-7 units), serialized
   * as a string. ALWAYS set by the SDK's scan adapters, alongside {@link amount},
   * so callers that need exactness above ~9.007e8 XLM (where a float can no
   * longer represent every stroop) can avoid the lossy `number`. Optional in the
   * type only for payments constructed OUTSIDE the SDK (e.g. rehydrated from an
   * older cache); set it whenever you build a `Payment` by hand — claims prefer
   * it over the lossy `number`. The `number` field is retained for display and
   * backwards compatibility.
   */
  amountStroops?: string;
  /** Which delivery method surfaced this payment */
  method: DeliveryMethod;
  /** Transaction hash that delivered the payment (when known) */
  txHash?: string;
}

/** Balance entry for a stealth address. */
export interface Balance {
  /** The stealth address */
  stealthAddress: string;
  /** Token contract address */
  token: string;
  /** Amount in whole units */
  amount: number;
  /**
   * Exact amount as a decimal `bigint` count of stroops, serialized as a string.
   * Always set, so callers can sum/display without a lossy float. See
   * {@link Payment.amountStroops}.
   */
  amountStroops: string;
}

/** Result of a withdrawal. */
export interface WithdrawReceipt {
  /** Transaction hash */
  txHash: string;
  /** Amount withdrawn in whole units */
  amount: number;
}

/** Options for sending to a stealth address. */
export interface SendOpts {
  /**
   * Delivery method to use. REQUIRED — callers must pick a method on every send.
   * Pass `'auto'` to let the client resolve one (native + amount > 1 + 'account'
   * enabled -> 'account'; otherwise 'pool').
   */
  method: DeliveryMethod | 'auto';
  /** Asset to send. Default: native XLM. Format: "CODE:ISSUER" */
  asset?: string;
  /**
   * External signer for the SENDER leg (Freighter-style). When set, the caller
   * passes a PUBLIC key (G...) where a secret is normally expected — `send()`'s
   * `senderSecret` positional carries the sender's G-address — and the SDK
   * delegates signing to this function instead of `Keypair.fromSecret`. The
   * stealth-key legs (claim/withdraw signatures) are unaffected: a wallet cannot
   * hold the derived stealth scalar, so those always sign locally.
   */
  signTransaction?: TransactionSigner;
  /**
   * The G-address of the fee payer when {@link signTransaction} is used on a
   * flow that needs a distinct fee payer. Unused by `send()` (whose fee payer is
   * the sender itself); present here for symmetry with {@link ClaimOpts}.
   */
  feePayerAddress?: string;
}

/** Options for withdrawing from a stealth address (pool method). */
export interface WithdrawOpts {
  /** Stealth keys (need view + spend private keys) */
  keys: StealthKeys;
  /** Secret key of account paying the Soroban invocation fee */
  feePayer: string;
  /** Relay URL for fee-bumped submission (privacy-preserving) */
  relay?: string;
  /** Asset to withdraw. Default: native XLM. Format: "CODE:ISSUER" */
  asset?: string;
  /** Amount to withdraw. Default: full balance */
  amount?: number;
  /**
   * App funding account (G-address) to debit the relayer fee against when the
   * relayer is credit-gated. Threaded into the `/relay` call so a gated relayer
   * does not respond 402 `insufficient_credit`. Ignored by a non-gated relayer.
   * See {@link ClaimOpts.fundingAccount}.
   */
  fundingAccount?: string;
}

/** Per-method scan cursors, so each adapter can resume where it left off. */
export interface ScanCursor {
  /** Pool announcement start index (next unread announcement) */
  pool?: string;
  /** Horizon paging token for the account method */
  account?: string;
  /** Reserved for the spp method */
  spp?: string;
}

/** Options controlling a cursor-aware scan. */
export interface ScanOpts {
  /** Restrict the scan to these methods (default: all enabled adapters) */
  methods?: DeliveryMethod[];
  /** Resume from a previously returned cursor */
  cursor?: ScanCursor;
}

/** Result of a cursor-aware scan. */
export interface ScanResult {
  /** Detected payments across all scanned methods */
  payments: Payment[];
  /** Updated cursor to persist and pass to the next scan */
  cursor: ScanCursor;
}

/** Options for claiming a detected payment. */
export interface ClaimOpts {
  /** Stealth keys (need view + spend private keys) */
  keys: StealthKeys;
  /** Relay URL for fee-bumped submission (privacy-preserving) */
  relay?: string;
  /**
   * For the account method: sweep the whole account via AccountMerge (default true).
   * Set false to leave the stealth account open (Payment, keeping the base reserve).
   * For the pool method this flag is ignored.
   */
  merge?: boolean;
  /** Secret key of an account paying the fee (pool method direct submission) */
  feePayer?: string;
  /** Asset to claim (pool method). Default: native XLM. Format: "CODE:ISSUER" */
  asset?: string;
  /**
   * Amount to claim. Default: full balance. Honored by POOL claims (partial
   * withdrawal) AND by account-method NATIVE claims with `merge: false`
   * (partial payout that keeps the stealth account open). Passing it on an
   * account-method native claim WITHOUT `merge: false`, or on an
   * account-method token claim (always claimed in full), throws
   * {@link ClaimAmountRequiresNoMergeError} instead of being silently ignored.
   */
  amount?: number;
  /**
   * For the account-method token claim: use the relayer's sponsor-claim pair
   * (prepare -> stealth-sign -> submit) instead of a self-funded stealth tx.
   * Needed when the stealth account stub is missing / cannot pay reserves.
   */
  sponsored?: boolean;
  /**
   * App funding account (G-address) to debit the relayer fee against when the
   * relayer is credit-gated (`RELAYER_REQUIRE_CREDIT=1`). Threaded into the
   * relay / sponsor-claim submit calls so a gated relayer does not respond 402
   * `insufficient_credit`. Ignored by a non-gated relayer.
   */
  fundingAccount?: string;
  /**
   * External signer for the FEE-PAYER leg (Freighter-style). When set on a pool
   * claim, the caller passes the fee payer's PUBLIC key via
   * {@link ClaimOpts.feePayerAddress} where a secret is normally expected (in
   * {@link ClaimOpts.feePayer}) and the SDK delegates signing of the fee-paying
   * transaction to this function instead of `Keypair.fromSecret`. The
   * stealth-key withdrawal signature is unaffected — a wallet cannot hold the
   * derived stealth scalar, so it always signs locally.
   */
  signTransaction?: TransactionSigner;
  /**
   * The fee payer's G-address, required when {@link signTransaction} is set on a
   * pool claim (which needs a fee payer). The SDK never calls
   * `Keypair.fromSecret` on this value; it is handed to {@link signTransaction}
   * as the address to sign with. When {@link signTransaction} is set but this is
   * missing, a {@link FeePayerAddressRequiredError} is thrown.
   */
  feePayerAddress?: string;
}

/** Receipt returned after a successful claim. */
export interface ClaimReceipt {
  /** Transaction hash */
  txHash: string;
  /** Amount claimed in whole units */
  amount: number;
  /** Which delivery method the claim used */
  method: DeliveryMethod;
}

/** Client configuration. */
export interface ClientConfig {
  /** Network to connect to */
  network: 'local' | 'testnet';
  /** Override the default contract ID for the stealth pool */
  contractId?: string;
  /** Override the Horizon REST endpoint (used by the account method) */
  horizonUrl?: string;
  /** Delivery methods to enable. Default: ['pool'] */
  methods?: DeliveryMethod[];
  /** Default relayer URL for fee-bumped submissions */
  relayer?: string;
}
