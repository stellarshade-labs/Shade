import { randomBytes } from '@noble/hashes/utils';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import type { StealthKeys, StealthMetaAddress } from './types.js';
import { L, scalarMultBase } from './ed25519.js';

/**
 * Generate a new stealth meta-address with random keys.
 * @returns Complete stealth keys including private keys and meta-address
 */
export function generateMetaAddress(): StealthKeys {
  // Generate two random 32-byte scalars (reduced mod L)
  const spendPrivKey = generateRandomScalar();
  const viewPrivKey = generateRandomScalar();

  // Derive public keys
  const spendPubKey = scalarMultBase(spendPrivKey);
  const viewPubKey = scalarMultBase(viewPrivKey);

  return {
    spendPrivKey,
    viewPrivKey,
    metaAddress: {
      spendPubKey,
      viewPubKey,
    },
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

/**
 * Encode a stealth meta-address to a string format.
 * @param meta Stealth meta-address containing public keys
 * @returns Encoded string in format "st:stellar:" + hex(spend_pk + view_pk)
 */
export function encodeMetaAddress(meta: StealthMetaAddress): string {
  if (meta.spendPubKey.length !== 32) {
    throw new Error('Invalid spend public key length');
  }
  if (meta.viewPubKey.length !== 32) {
    throw new Error('Invalid view public key length');
  }

  // Concatenate both public keys
  const combined = new Uint8Array(64);
  combined.set(meta.spendPubKey, 0);
  combined.set(meta.viewPubKey, 32);

  // Convert to hex
  const hex = Array.from(combined)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `st:stellar:${hex}`;
}

/**
 * Decode a string-encoded stealth meta-address.
 * @param encoded Encoded meta-address string
 * @returns Decoded stealth meta-address
 */
export function decodeMetaAddress(encoded: string): StealthMetaAddress {
  if (!encoded.startsWith('st:stellar:')) {
    throw new Error('Invalid meta-address prefix');
  }

  const hex = encoded.slice(11); // Remove "st:stellar:" prefix
  if (hex.length !== 128) {
    // 64 bytes = 128 hex chars
    throw new Error('Invalid meta-address length');
  }

  // Parse hex to bytes
  const combined = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    combined[i] = parseInt(hex.substr(i * 2, 2), 16);
  }

  return {
    spendPubKey: combined.slice(0, 32),
    viewPubKey: combined.slice(32, 64),
  };
}