import { scalarMult, scalarAdd } from './ed25519.js';
import { hashToScalar } from './hash.js';

/**
 * Recover the stealth private key for a stealth address.
 *
 * This implements the receiver's private key recovery:
 * 1. Compute shared secret S = k_view * R
 * 2. Hash to scalar s = SHA256(S) mod L
 * 3. Compute stealth private key p = k_spend + s mod L
 *
 * The recovered private key can be used to:
 * - Sign transactions from the stealth address
 * - Derive the corresponding public key for verification
 *
 * @param spendPrivKey Receiver's spend private key
 * @param viewPrivKey Receiver's view private key
 * @param ephemeralPubKey Ephemeral public key from announcement
 * @returns 32-byte stealth private key
 */
export function recoverStealthPrivateKey(
  spendPrivKey: Uint8Array,
  viewPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): Uint8Array {
  if (spendPrivKey.length !== 32) {
    throw new Error('Invalid spend private key length');
  }
  if (viewPrivKey.length !== 32) {
    throw new Error('Invalid view private key length');
  }
  if (ephemeralPubKey.length !== 32) {
    throw new Error('Invalid ephemeral public key length');
  }

  // Step 1: Compute shared secret S = k_view * R
  const S = scalarMult(viewPrivKey, ephemeralPubKey);

  // Step 2: Hash shared secret to scalar s = SHA256(S) mod L
  const s = hashToScalar(S);

  // Step 3: Compute stealth private key p = k_spend + s mod L
  const stealthPrivKey = scalarAdd(spendPrivKey, s);

  return stealthPrivKey;
}