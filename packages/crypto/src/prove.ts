import { ed25519 } from '@noble/curves/ed25519';

/**
 * Prove ownership of a stealth address by signing a challenge.
 *
 * This creates an ed25519 signature using the stealth private key,
 * which can be verified against the stealth public key.
 * Used by relayers to verify withdrawal requests are from legitimate owners.
 *
 * @param stealthPrivKey The stealth private key (32 bytes)
 * @param challenge The challenge to sign (typically a nonce or timestamp)
 * @returns The ed25519 signature (64 bytes)
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

  // Sign the challenge with the stealth private key
  const signature = ed25519.sign(challenge, stealthPrivKey);

  return signature;
}

/**
 * Verify ownership proof of a stealth address.
 *
 * Verifies an ed25519 signature against the stealth public key.
 * Used by relayers to authenticate withdrawal requests.
 *
 * @param stealthPubKey The stealth public key (32 bytes)
 * @param challenge The challenge that was signed
 * @param signature The signature to verify (64 bytes)
 * @returns True if the signature is valid, false otherwise
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