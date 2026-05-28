import { randomBytes } from '@noble/hashes/utils';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import type { StealthMetaAddress } from './types.js';
import { L, scalarMultBase, scalarMult, pointAdd, validatePoint } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';
import { InvalidPublicKey } from './errors.js';

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
 * @param metaAddr - Receiver's stealth meta-address containing spend and view public keys
 * @returns Derived stealth address and announcement data
 * @throws {InvalidPublicKey} If meta-address keys are invalid or not on curve
 *
 * @example
 * ```typescript
 * const receiver = generateMetaAddress();
 * const stealth = deriveStealthAddress(receiver.metaAddress);
 *
 * // Send XLM to stealth.stealthAddress
 * console.log('Send to:', stealth.stealthAddress);
 *
 * // Publish announcement data
 * announcePayment({
 *   ephemeralPubKey: stealth.ephemeralPubKey,
 *   viewTag: stealth.viewTag,
 *   stealthAddress: stealth.stealthAddress
 * });
 * ```
 */
export function deriveStealthAddress(metaAddr: StealthMetaAddress): StealthDerivation {
  if (!metaAddr) {
    throw new InvalidPublicKey('Meta-address is required');
  }
  if (metaAddr.spendPubKey.length !== 32) {
    throw new InvalidPublicKey('Invalid spend public key length');
  }
  if (metaAddr.viewPubKey.length !== 32) {
    throw new InvalidPublicKey('Invalid view public key length');
  }

  // Validate both keys are on curve
  validatePoint(metaAddr.spendPubKey);
  validatePoint(metaAddr.viewPubKey);

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
 * Compute a stealth address from spend and view public keys.
 *
 * Convenience function that creates a meta-address and derives
 * a stealth address from it.
 *
 * @param spendPubKey - Receiver's 32-byte spend public key
 * @param viewPubKey - Receiver's 32-byte view public key
 * @returns Derived stealth address and announcement data
 * @throws {InvalidPublicKey} If public keys are invalid
 *
 * @example
 * ```typescript
 * const stealth = computeStealthAddress(spendPubKey, viewPubKey);
 * console.log('Send to:', stealth.stealthAddress);
 * ```
 */
export function computeStealthAddress(
  spendPubKey: Uint8Array,
  viewPubKey: Uint8Array
): StealthDerivation {
  return deriveStealthAddress({ spendPubKey, viewPubKey });
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