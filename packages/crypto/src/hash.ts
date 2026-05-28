import { sha256 } from '@noble/hashes/sha256';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { L } from './ed25519.js';
import { InvalidScalar } from './errors.js';

/**
 * Hash data to a scalar value modulo curve order L.
 * @param data Input data to hash
 * @returns 32-byte scalar (little-endian, reduced mod L)
 * @throws InvalidScalar if hash produces zero scalar
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
 * @param sharedSecret 32-byte shared secret
 * @returns Single byte view tag (first byte of SHA256)
 */
export function viewTag(sharedSecret: Uint8Array): number {
  if (sharedSecret.length !== 32) {
    throw new Error('Invalid shared secret length');
  }
  const hash = sha256(sharedSecret);
  return hash[0]!;
}