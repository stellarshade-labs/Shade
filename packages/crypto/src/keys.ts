import { randomBytes } from '@noble/hashes/utils';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { sha256 } from '@noble/hashes/sha256';
import type { StealthKeys, StealthMetaAddress } from './types.js';
import { L, scalarMultBase, validatePoint } from './ed25519.js';
import { InvalidMetaAddress, InvalidPublicKey } from './errors.js';

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
 * Encode a stealth meta-address to a string format with checksum.
 * @param meta Stealth meta-address containing public keys
 * @returns Encoded string in format "st:stellar:<hex(spend_pk || view_pk)><checksum>"
 */
export function encodeMetaAddress(meta: StealthMetaAddress): string {
  if (meta.spendPubKey.length !== 32) {
    throw new InvalidMetaAddress('Invalid spend public key length');
  }
  if (meta.viewPubKey.length !== 32) {
    throw new InvalidMetaAddress('Invalid view public key length');
  }

  // Validate both keys are on curve
  try {
    validatePoint(meta.spendPubKey);
    validatePoint(meta.viewPubKey);
  } catch (e) {
    if (e instanceof InvalidPublicKey) {
      throw new InvalidMetaAddress(`Invalid public key: ${e.message}`);
    }
    throw e;
  }

  // Concatenate both public keys
  const payload = new Uint8Array(64);
  payload.set(meta.spendPubKey, 0);
  payload.set(meta.viewPubKey, 32);

  // Calculate checksum (last 4 bytes of SHA-256)
  const hash = sha256(payload);
  const checksum = hash.slice(28, 32);

  // Combine payload and checksum
  const combined = new Uint8Array(68);
  combined.set(payload, 0);
  combined.set(checksum, 64);

  // Convert to hex
  const hex = Array.from(combined)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `st:stellar:${hex}`;
}

/**
 * Decode a string-encoded stealth meta-address with checksum validation.
 * @param encoded Encoded meta-address string
 * @returns Decoded stealth meta-address
 * @throws InvalidMetaAddress if format or checksum is invalid
 */
export function decodeMetaAddress(encoded: string): StealthMetaAddress {
  if (!encoded.startsWith('st:stellar:')) {
    throw new InvalidMetaAddress('Invalid meta-address prefix');
  }

  const hex = encoded.slice(11); // Remove "st:stellar:" prefix
  if (hex.length !== 136) {
    // 64 bytes payload + 4 bytes checksum = 68 bytes = 136 hex chars
    throw new InvalidMetaAddress('Invalid meta-address length');
  }

  // Parse hex to bytes
  const combined = new Uint8Array(68);
  for (let i = 0; i < 68; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (isNaN(byte)) {
      throw new InvalidMetaAddress('Invalid hex encoding');
    }
    combined[i] = byte;
  }

  // Split payload and checksum
  const payload = combined.slice(0, 64);
  const checksum = combined.slice(64, 68);

  // Verify checksum
  const hash = sha256(payload);
  const expectedChecksum = hash.slice(28, 32);

  let checksumValid = true;
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      checksumValid = false;
      break;
    }
  }

  if (!checksumValid) {
    throw new InvalidMetaAddress('Invalid checksum');
  }

  const spendPubKey = payload.slice(0, 32);
  const viewPubKey = payload.slice(32, 64);

  // Validate both keys are on curve
  try {
    validatePoint(spendPubKey);
    validatePoint(viewPubKey);
  } catch (e) {
    if (e instanceof InvalidPublicKey) {
      throw new InvalidMetaAddress(`Invalid public key in meta-address: ${e.message}`);
    }
    throw e;
  }

  return {
    spendPubKey,
    viewPubKey,
  };
}