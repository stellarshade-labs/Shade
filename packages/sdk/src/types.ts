/**
 * A delivery method describes HOW a stealth payment reaches its recipient.
 * - `'pool'`  — deposit into the Soroban pool contract (default, private, any SAC token).
 * - `'account'` — a direct classic Stellar payment that creates/pays a one-time stealth
 *   account, with the ephemeral key carried in a MemoHash. Native XLM only for now.
 * - `'spp'` — reserved slot for a future Stellar Private Payments (ZK shielded pool) integration.
 */
export type DeliveryMethod = 'pool' | 'account' | 'spp';

/** Stealth key material. All keys are hex-encoded strings for easy serialization. */
export interface StealthKeys {
  /** Meta-address string (st:stellar:...) — share this publicly */
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
  /** Token contract address (or the string 'native' for direct XLM sends) */
  token: string;
  /**
   * Asset in Horizon "CODE:ISSUER" form (or 'native') for account-method token
   * payments. Present only when the payment arrived as a claimable balance.
   */
  asset?: string;
  /**
   * Claimable balance id (account-method token payments only). Its presence is
   * what marks a payment as a token claim rather than a plain XLM send.
   */
  claimableBalanceId?: string;
  /** Amount in whole units (e.g. 100.0 = 100 XLM) */
  amount: number;
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
  /** Amount to claim (pool method). Default: full balance */
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
