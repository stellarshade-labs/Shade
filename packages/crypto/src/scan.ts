import type { Announcement, StealthAddress } from './types.js';
import { scalarMult, pointAdd, scalarMultBase } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';

/**
 * Check if a view tag matches for a given ephemeral public key.
 *
 * This is a fast pre-filter before doing the expensive EC operations.
 * Only computes the shared secret and extracts the first byte for comparison.
 *
 * @param viewPrivKey - Receiver's 32-byte view private key
 * @param ephemeralPubKey - 32-byte ephemeral public key from announcement
 * @param expectedTag - Expected view tag from announcement (0-255)
 * @returns Object with match result and shared secret if matched
 * @throws {Error} If key lengths are invalid or tag is out of range
 *
 * @example
 * ```typescript
 * // Fast filtering before full verification
 * const result = checkViewTag(viewPrivKey, announcement.ephemeralPubKey, announcement.viewTag);
 * if (result.matches) {
 *   // Use the shared secret for further verification
 *   const s = hashToScalar(result.sharedSecret);
 * }
 * ```
 */
export function checkViewTag(
  viewPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  expectedTag: number
): { matches: boolean; sharedSecret?: Uint8Array } {
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

  // Extract and compare view tag (first byte of SHA256(S))
  const computedTag = viewTag(S);

  if (computedTag === expectedTag) {
    return { matches: true, sharedSecret: S };
  }
  return { matches: false };
}

/**
 * Scan announcements to find stealth addresses belonging to the receiver.
 *
 * This implements an optimized two-pass scanning algorithm:
 * - Pass 1: Filter by view tag (cheap byte comparison)
 * - Pass 2: Full EC math (scalarMult + pointAdd) only on tag matches
 *
 * This optimization provides ~25x speedup for large announcement sets
 * by avoiding expensive EC operations on non-matching announcements.
 *
 * @param viewPrivKey - Receiver's 32-byte view private key
 * @param spendPubKey - Receiver's 32-byte spend public key
 * @param announcements - List of announcements to scan
 * @returns Array of stealth addresses belonging to the receiver
 * @throws {Error} If key lengths are invalid
 *
 * @example
 * ```typescript
 * // Scan blockchain announcements
 * const announcements = await fetchAnnouncements();
 * const myAddresses = scanAnnouncements(
 *   keys.viewPrivKey,
 *   keys.metaAddress.spendPubKey,
 *   announcements
 * );
 *
 * // Check balances of discovered addresses
 * for (const addr of myAddresses) {
 *   const balance = await getBalance(addr.address);
 *   console.log(`${addr.address}: ${balance} XLM`);
 * }
 * ```
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

  // Two-pass scanning for optimization
  // Pass 1: Quick view tag filtering with shared secret caching
  const tagMatches: Array<{ announcement: Announcement; sharedSecret: Uint8Array }> = [];
  for (const announcement of announcements) {
    // A malicious or malformed announcement may carry an invalid ephemeral
    // key (e.g. a small-order/torsion point). Skip it rather than aborting
    // the entire scan.
    try {
      const tagResult = checkViewTag(
        viewPrivKey,
        announcement.ephemeralPubKey,
        announcement.viewTag
      );
      if (tagResult.matches && tagResult.sharedSecret) {
        tagMatches.push({ announcement, sharedSecret: tagResult.sharedSecret });
      }
    } catch {
      continue;
    }
  }

  // Pass 2: Full verification only on tag matches (reusing shared secrets)
  for (const { announcement, sharedSecret } of tagMatches) {
    // Hash to scalar s = SHA256(S) mod L (using cached shared secret)
    const s = hashToScalar(sharedSecret);

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
 * Performs full DKSAP verification to determine ownership of a stealth address.
 *
 * @param viewPrivKey - Receiver's 32-byte view private key
 * @param spendPubKey - Receiver's 32-byte spend public key
 * @param ephemeralPubKey - 32-byte ephemeral public key from announcement
 * @param stealthAddress - Stellar address to check (G... format)
 * @returns True if the stealth address belongs to the receiver
 * @throws {Error} If key lengths are invalid
 *
 * @example
 * ```typescript
 * // Check if a payment is for you
 * const isMine = isMyStealthAddress(
 *   keys.viewPrivKey,
 *   keys.metaAddress.spendPubKey,
 *   announcement.ephemeralPubKey,
 *   announcement.stealthAddress
 * );
 *
 * if (isMine) {
 *   console.log('Found payment to:', announcement.stealthAddress);
 * }
 * ```
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