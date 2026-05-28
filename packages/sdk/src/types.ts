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
  /** Ephemeral public key from the announcement (hex) */
  ephemeralPubKey: string;
  /** Token contract address */
  token: string;
  /** Amount in whole units (e.g. 100.0 = 100 XLM) */
  amount: number;
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
  /** Asset to send. Default: native XLM. Format: "CODE:ISSUER" */
  asset?: string;
}

/** Options for withdrawing from a stealth address. */
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

/** Client configuration. */
export interface ClientConfig {
  /** Network to connect to */
  network: 'local' | 'testnet';
  /** Override the default contract ID for the stealth pool */
  contractId?: string;
}
