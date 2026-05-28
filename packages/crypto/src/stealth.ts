import { randomBytes } from '@noble/hashes/utils';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import type { StealthMetaAddress } from './types.js';
import { L, scalarMultBase, scalarMult, pointAdd } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';

/**
 * Stealth address derivation result.
 */
export interface StealthDerivation {
  /** 32-byte stealth public key */
  stealthPubKey: Uint8Array;
  /** Stellar address of stealth account (G... format) */
  stealthAddress: string;
  /** 32-byte ephemeral public key (R = r*G) */
  ephemeralPubKey: Uint8Array;
  /** Single byte view tag for fast scanning */
  viewTag: number;
  /** 32-byte ephemeral private key (for sender's records only) */
  ephemeralPrivKey: Uint8Array;
}

/**
 * Derive a stealth address from a meta-address.
 *
 * This implements the sender's side of the DKSAP protocol:
 * 1. Generate random ephemeral key r
 * 2. Compute ephemeral public key R = r*G
 * 3. Compute shared secret S = r*K_view
 * 4. Hash to scalar s = SHA256(S) mod L
 * 5. Compute stealth public key P = K_spend + s*G
 * 6. Extract view tag from shared secret
 *
 * @param metaAddr Receiver's stealth meta-address
 * @returns Derived stealth address and announcement data
 */
export function deriveStealthAddress(metaAddr: StealthMetaAddress): StealthDerivation {
  if (metaAddr.spendPubKey.length !== 32) {
    throw new Error('Invalid spend public key length');
  }
  if (metaAddr.viewPubKey.length !== 32) {
    throw new Error('Invalid view public key length');
  }

  // Step 1: Generate random ephemeral scalar r
  const r = generateRandomScalar();

  // Step 2: Compute ephemeral public key R = r*G
  const R = scalarMultBase(r);

  // Step 3: Compute shared secret S = r*K_view
  const S = scalarMult(r, metaAddr.viewPubKey);

  // Step 4: Hash shared secret to scalar s = SHA256(S) mod L
  const s = hashToScalar(S);

  // Step 5: Compute stealth public key P = K_spend + s*G
  const sG = scalarMultBase(s);
  const P = pointAdd(metaAddr.spendPubKey, sG);

  // Step 6: Extract view tag from shared secret
  const vt = viewTag(S);

  // Convert to Stellar address
  const stealthAddress = encodePublicKey(P);

  return {
    stealthPubKey: P,
    stealthAddress,
    ephemeralPubKey: R,
    viewTag: vt,
    ephemeralPrivKey: r,
  };
}

/**
 * Generate a random scalar reduced modulo L.
 * @returns 32-byte scalar (little-endian, reduced mod L)
 */
function generateRandomScalar(): Uint8Array {
  const bytes = randomBytes(32);
  const scalar = bytesToNumberLE(bytes) % L;
  return numberToBytesLE(scalar, 32);
}