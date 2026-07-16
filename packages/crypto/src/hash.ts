import { sha256 } from '@noble/hashes/sha256';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { L } from './ed25519.js';
import { InvalidScalar } from './errors.js';

/**
 * Hash data to a scalar value modulo curve order L.
 *
 * Implements the hash-to-scalar function used in DKSAP for deriving
 * the blinding factor from the shared secret.
 *
 * @param data - Input data to hash (typically a 32-byte shared secret)
 * @returns 32-byte scalar (little-endian, reduced mod L)
 * @throws {InvalidScalar} If hash produces zero scalar (extremely unlikely)
 *
 * @example
 * ```typescript
 * const sharedSecret = scalarMult(ephemeralPrivKey, viewPubKey);
 * const s = hashToScalar(sharedSecret);
 * // Use s as blinding factor for stealth key derivation
 * ```
 */
export function hashToScalar(data: Uint8Array): Uint8Array {
  const hash = sha256(data);
  const scalar = bytesToNumberLE(hash) % L;

  // In the extremely unlikely event the hash produces zero mod L
  if (scalar === 0n) {
    throw new InvalidScalar('Hash produced zero scalar');
  }

  return numberToBytesLE(scalar, 32);
}

/**
 * Extract view tag from shared secret.
 *
 * The view tag is the first byte of SHA256(shared_secret) and enables
 * ~2x faster scanning by filtering announcements before expensive EC operations.
 *
 * @param sharedSecret - 32-byte shared secret from ECDH
 * @returns Single byte view tag (0-255)
 * @throws {Error} If shared secret is not 32 bytes
 *
 * @example
 * ```typescript
 * const sharedSecret = scalarMult(viewPrivKey, ephemeralPubKey);
 * const tag = viewTag(sharedSecret);
 * // Use tag for fast announcement filtering
 * ```
 */
export function viewTag(sharedSecret: Uint8Array): number {
  if (sharedSecret.length !== 32) {
    throw new Error('Invalid shared secret length');
  }
  const hash = sha256(sharedSecret);
  return hash[0]!;
}