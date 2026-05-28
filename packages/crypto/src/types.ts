/**
 * Meta-address containing spending and viewing public keys for stealth addresses.
 */
export interface StealthMetaAddress {
  /** 32-byte ed25519 public key for spending */
  spendPubKey: Uint8Array;
  /** 32-byte ed25519 public key for viewing */
  viewPubKey: Uint8Array;
}

/**
 * Complete stealth key pair including private keys and derived meta-address.
 */
export interface StealthKeys {
  /** 32-byte ed25519 private key for spending */
  spendPrivKey: Uint8Array;
  /** 32-byte ed25519 private key for viewing */
  viewPrivKey: Uint8Array;
  /** Derived meta-address containing public keys */
  metaAddress: StealthMetaAddress;
}

/**
 * Announcement data for stealth payments, posted on-chain.
 */
export interface Announcement {
  /** 32-byte ephemeral public key R = r*G */
  ephemeralPubKey: Uint8Array;
  /** Single byte view tag for fast scanning */
  viewTag: number;
  /** Stellar address of the stealth account (G... format) */
  stealthAddress: string;
  /** Optional transaction hash where payment was made */
  txHash?: string;
}

/**
 * Derived stealth address ready for receiving payments.
 */
export interface StealthAddress {
  /** 32-byte ed25519 public key */
  publicKey: Uint8Array;
  /** Stellar address in StrKey format (G...) */
  address: string;
}