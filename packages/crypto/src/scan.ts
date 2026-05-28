import type { Announcement, StealthAddress } from './types.js';
import { scalarMult, pointAdd, scalarMultBase } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';

/**
 * Check if a view tag matches for a given ephemeral public key.
 *
 * This is a fast pre-filter before doing the expensive EC operations.
 *
 * @param viewPrivKey Receiver's view private key
 * @param ephemeralPubKey Ephemeral public key from announcement
 * @param expectedTag Expected view tag from announcement
 * @returns True if view tag matches
 */
export function checkViewTag(
  viewPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  expectedTag: number
): boolean {
  if (viewPrivKey.length !== 32) {
    throw new Error('Invalid view private key length');
  }
  if (ephemeralPubKey.length !== 32) {
    throw new Error('Invalid ephemeral public key length');
  }
  if (expectedTag < 0 || expectedTag > 255) {
    throw new Error('Invalid view tag');
  }

  // Compute shared secret S = k_view * R
  const S = scalarMult(viewPrivKey, ephemeralPubKey);

  // Extract and compare view tag
  const computedTag = viewTag(S);
  return computedTag === expectedTag;
}

/**
 * Scan announcements to find stealth addresses belonging to the receiver.
 *
 * This implements the receiver's scanning logic:
 * 1. First pass: Filter by view tag (fast)
 * 2. Second pass: Full EC math on matching announcements
 *
 * @param viewPrivKey Receiver's view private key
 * @param spendPubKey Receiver's spend public key
 * @param announcements List of announcements to scan
 * @returns Array of stealth addresses belonging to the receiver
 */
export function scanAnnouncements(
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  announcements: Announcement[]
): StealthAddress[] {
  if (viewPrivKey.length !== 32) {
    throw new Error('Invalid view private key length');
  }
  if (spendPubKey.length !== 32) {
    throw new Error('Invalid spend public key length');
  }

  const results: StealthAddress[] = [];

  for (const announcement of announcements) {
    // First pass: Check view tag (fast filter)
    if (!checkViewTag(viewPrivKey, announcement.ephemeralPubKey, announcement.viewTag)) {
      continue;
    }

    // Second pass: Full EC math for matching view tags
    // Compute shared secret S = k_view * R
    const S = scalarMult(viewPrivKey, announcement.ephemeralPubKey);

    // Hash to scalar s = SHA256(S) mod L
    const s = hashToScalar(S);

    // Compute expected stealth public key P = K_spend + s*G
    const sG = scalarMultBase(s);
    const P = pointAdd(spendPubKey, sG);

    // Convert to Stellar address and compare
    const computedAddress = encodePublicKey(P);

    if (computedAddress === announcement.stealthAddress) {
      results.push({
        publicKey: P,
        address: computedAddress,
      });
    }
  }

  return results;
}

/**
 * Check if a specific stealth address belongs to the receiver.
 *
 * @param viewPrivKey Receiver's view private key
 * @param spendPubKey Receiver's spend public key
 * @param ephemeralPubKey Ephemeral public key from announcement
 * @param stealthAddress Stealth address to check
 * @returns True if the stealth address belongs to the receiver
 */
export function isMyStealthAddress(
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  stealthAddress: string
): boolean {
  if (viewPrivKey.length !== 32) {
    throw new Error('Invalid view private key length');
  }
  if (spendPubKey.length !== 32) {
    throw new Error('Invalid spend public key length');
  }
  if (ephemeralPubKey.length !== 32) {
    throw new Error('Invalid ephemeral public key length');
  }

  // Compute shared secret S = k_view * R
  const S = scalarMult(viewPrivKey, ephemeralPubKey);

  // Hash to scalar s = SHA256(S) mod L
  const s = hashToScalar(S);

  // Compute expected stealth public key P = K_spend + s*G
  const sG = scalarMultBase(s);
  const P = pointAdd(spendPubKey, sG);

  // Convert to Stellar address and compare
  const computedAddress = encodePublicKey(P);

  return computedAddress === stealthAddress;
}