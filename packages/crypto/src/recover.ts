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
 * WARNING: The returned value is a RAW ed25519 SCALAR (k_spend + s mod L),
 * NOT an ed25519 seed. You MUST sign with {@link signWithStealthKey} from
 * this package. Do NOT construct a Stellar/ed25519 Keypair from it via
 * `Keypair.fromRawEd25519Seed()` or any seed-based API: those APIs HASH the
 * input to derive a different signing scalar, producing a key that does not
 * match the stealth public key — the contract will reject the signature and
 * the funds become unwithdrawable.
 *
 * @param spendPrivKey - Receiver's 32-byte spend private key
 * @param viewPrivKey - Receiver's 32-byte view private key
 * @param ephemeralPubKey - 32-byte ephemeral public key from announcement
 * @returns 32-byte stealth private key (raw scalar) for signing transactions
 * @throws {Error} If key lengths are invalid
 *
 * @example
 * ```typescript
 * import { recoverStealthPrivateKey, signWithStealthKey } from '@stealth/crypto';
 *
 * // Recover the raw stealth scalar to withdraw funds
 * const stealthPrivKey = recoverStealthPrivateKey(
 *   keys.spendPrivKey,
 *   keys.viewPrivKey,
 *   announcement.ephemeralPubKey
 * );
 *
 * // Sign the withdrawal message with the raw scalar (do NOT build a
 * // Keypair from fromRawEd25519Seed — that hashes to a different key).
 * const signature = signWithStealthKey(withdrawMessage, stealthPrivKey);
 *
 * // IMPORTANT: Clear private key from memory after use
 * stealthPrivKey.fill(0);
 * ```
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