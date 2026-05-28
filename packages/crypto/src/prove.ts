import { ed25519 } from '@noble/curves/ed25519';

/**
 * Prove ownership of a stealth address by signing a challenge.
 *
 * This creates an ed25519 signature using the stealth private key,
 * which can be verified against the stealth public key.
 * Used by relayers to verify withdrawal requests are from legitimate owners.
 *
 * @param stealthPrivKey - The 32-byte stealth private key (scalar)
 * @param challenge - The challenge to sign (typically a nonce or timestamp)
 * @returns The 64-byte ed25519 signature
 * @throws {Error} If private key is not 32 bytes or challenge is empty
 *
 * @example
 * ```typescript
 * // Create ownership proof for withdrawal request
 * const challenge = new TextEncoder().encode(`withdraw:${Date.now()}`);
 * const proof = proveOwnership(stealthPrivKey, challenge);
 *
 * // Submit to relayer
 * await relayer.requestWithdrawal({
 *   stealthAddress,
 *   proof,
 *   challenge
 * });
 * ```
 */
export function proveOwnership(
  stealthPrivKey: Uint8Array,
  challenge: Uint8Array
): Uint8Array {
  if (stealthPrivKey.length !== 32) {
    throw new Error('Invalid stealth private key length');
  }
  if (challenge.length === 0) {
    throw new Error('Challenge cannot be empty');
  }

  // The stealth private key is a scalar, we need to use it as a seed for ed25519
  // This matches how Stellar SDK handles private keys
  const signature = ed25519.sign(challenge, stealthPrivKey);

  return signature;
}

/**
 * Verify ownership proof of a stealth address.
 *
 * Verifies an ed25519 signature against the stealth public key.
 * Used by relayers to authenticate withdrawal requests.
 *
 * @param stealthPubKey - The 32-byte stealth public key
 * @param challenge - The challenge that was signed
 * @param signature - The 64-byte signature to verify
 * @returns True if the signature is valid, false otherwise
 * @throws {Error} If key/signature lengths are invalid or challenge is empty
 *
 * @example
 * ```typescript
 * // Verify withdrawal request (relayer side)
 * const isValid = verifyOwnership(
 *   stealthPubKey,
 *   challenge,
 *   signature
 * );
 *
 * if (isValid) {
 *   // Process withdrawal
 *   await sponsorTransaction(stealthAddress, destination, amount);
 * } else {
 *   throw new Error('Invalid ownership proof');
 * }
 * ```
 */
export function verifyOwnership(
  stealthPubKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array
): boolean {
  if (stealthPubKey.length !== 32) {
    throw new Error('Invalid stealth public key length');
  }
  if (challenge.length === 0) {
    throw new Error('Challenge cannot be empty');
  }
  if (signature.length !== 64) {
    throw new Error('Invalid signature length');
  }

  try {
    // Verify the signature against the stealth public key
    return ed25519.verify(signature, challenge, stealthPubKey);
  } catch {
    // Invalid signature or key
    return false;
  }
}