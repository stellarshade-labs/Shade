import { scalarMult, scalarAdd } from './ed25519.js';
import { hashToScalar } from './hash.js';
import { StealthScalar } from './scalar.js';

/**
 * Recover the stealth private key for a stealth address.
 *
 * This implements the receiver's private key recovery:
 * 1. Compute shared secret S = k_view * R
 * 2. Hash to scalar s = SHA256(S) mod L
 * 3. Compute stealth private key p = k_spend + s mod L
 *
 * The recovered key can be used to:
 * - Sign transactions from the stealth address ({@link StealthScalar.sign})
 * - Derive the corresponding public key for verification
 *   ({@link StealthScalar.publicKey})
 *
 * WARNING: The recovered value is a RAW ed25519 SCALAR (k_spend + s mod L),
 * NOT an ed25519 seed — which is why it is returned as a {@link StealthScalar}
 * wrapper instead of bytes. Do NOT extract the bytes
 * ({@link StealthScalar.dangerouslyToRawBytes}) to construct a Stellar/ed25519
 * Keypair via `Keypair.fromRawEd25519Seed()` or any seed-based API: those APIs
 * HASH the input to derive a different signing scalar, producing a key that
 * does not match the stealth public key — the contract will reject the
 * signature and the funds become permanently unwithdrawable. Sign through the
 * wrapper (or `signWithStealthKey`) instead.
 *
 * @param spendPrivKey - Receiver's 32-byte spend private key
 * @param viewPrivKey - Receiver's 32-byte view private key
 * @param ephemeralPubKey - 32-byte ephemeral public key from announcement
 * @returns The stealth private key (raw scalar) wrapped as a {@link StealthScalar}
 * @throws {Error} If key lengths are invalid
 *
 * @example
 * ```typescript
 * import { recoverStealthPrivateKey } from '@shade/crypto';
 *
 * // Recover the stealth scalar to withdraw funds
 * const stealthKey = recoverStealthPrivateKey(
 *   keys.spendPrivKey,
 *   keys.viewPrivKey,
 *   announcement.ephemeralPubKey
 * );
 *
 * // Sign the withdrawal message through the wrapper (do NOT build a Keypair
 * // from the raw bytes — seed APIs hash to a different, fund-losing key).
 * const signature = stealthKey.sign(withdrawMessage);
 *
 * // IMPORTANT: Clear the private key from memory after use
 * stealthKey.zeroize();
 * ```
 */
export function recoverStealthPrivateKey(
  spendPrivKey: Uint8Array,
  viewPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): StealthScalar {
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

  // The wrapper copies the bytes; zero the loose intermediate so the wrapper
  // holds the only live copy (zeroize() then actually clears the key).
  const scalar = StealthScalar.fromBytes(stealthPrivKey);
  stealthPrivKey.fill(0);

  return scalar;
}

/**
 * Recover the stealth private key as raw bytes (pre-0.1.0 behavior).
 *
 * @deprecated Use {@link recoverStealthPrivateKey}, which returns a
 * {@link StealthScalar} wrapper: sign with `.sign(message)`, verify with
 * `.publicKey()`, clear with `.zeroize()`. If you truly need raw bytes,
 * call `.dangerouslyToRawBytes()` — and NEVER feed them to a seed-based
 * Keypair API (`Keypair.fromRawEd25519Seed()` etc.), which hashes the input
 * into a mismatched key and makes the funds permanently unwithdrawable.
 *
 * @param spendPrivKey - Receiver's 32-byte spend private key
 * @param viewPrivKey - Receiver's 32-byte view private key
 * @param ephemeralPubKey - 32-byte ephemeral public key from announcement
 * @returns 32-byte stealth private key (raw scalar) for signing transactions
 * @throws {Error} If key lengths are invalid
 */
export function recoverStealthPrivateKeyBytes(
  spendPrivKey: Uint8Array,
  viewPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): Uint8Array {
  return recoverStealthPrivateKey(
    spendPrivKey,
    viewPrivKey,
    ephemeralPubKey,
  ).dangerouslyToRawBytes();
}
