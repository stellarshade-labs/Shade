import { ed25519 } from '@noble/curves/ed25519';
import { StealthScalar, signWithRawScalarBytes } from './scalar.js';

/**
 * Sign a message using a stealth private key (raw ed25519 scalar).
 *
 * Standard ed25519.sign() hashes the seed to derive the signing scalar,
 * but stealth private keys are already raw scalars from modular addition
 * (k_spend + s mod L). This function constructs a valid ed25519 signature
 * directly from the raw scalar, producing signatures that verify with
 * standard ed25519.verify() against the corresponding public key (scalar * G).
 *
 * @param message - The message to sign
 * @param key - The recovered stealth key ({@link StealthScalar})
 * @returns 64-byte ed25519 signature (R || S)
 */
export function signWithStealthKey(
  message: Uint8Array,
  key: StealthScalar,
): Uint8Array;
/**
 * Sign a message using a raw 32-byte scalar.
 *
 * @deprecated Pass the {@link StealthScalar} returned by
 * `recoverStealthPrivateKey` (or call its `.sign(message)` directly) instead
 * of raw bytes — raw scalar bytes are one `Keypair.fromRawEd25519Seed()` away
 * from permanently unwithdrawable funds.
 *
 * @param message - The message to sign
 * @param privateScalar - 32-byte raw scalar (stealth private key)
 * @returns 64-byte ed25519 signature (R || S)
 */
export function signWithStealthKey(
  message: Uint8Array,
  privateScalar: Uint8Array,
): Uint8Array;
export function signWithStealthKey(
  message: Uint8Array,
  key: StealthScalar | Uint8Array,
): Uint8Array {
  if (key instanceof StealthScalar) {
    return key.sign(message);
  }
  return signWithRawScalarBytes(message, key);
}

/**
 * Prove ownership of a stealth address by signing a challenge.
 *
 * Uses raw-scalar ed25519 signing so the signature verifies against
 * the stealth public key (privateScalar * G), not the hashed-seed public key.
 *
 * @param stealthPrivKey - The recovered stealth key ({@link StealthScalar};
 *   passing raw 32-byte scalar bytes is deprecated — see
 *   {@link signWithStealthKey})
 * @param challenge - The challenge to sign (typically a nonce or timestamp)
 * @returns The 64-byte ed25519 signature
 * @throws {Error} If private key is not 32 bytes or challenge is empty
 */
export function proveOwnership(
  stealthPrivKey: StealthScalar | Uint8Array,
  challenge: Uint8Array
): Uint8Array {
  if (stealthPrivKey instanceof StealthScalar) {
    return stealthPrivKey.sign(challenge);
  }
  return signWithRawScalarBytes(challenge, stealthPrivKey);
}

/**
 * Verify ownership proof of a stealth address.
 *
 * Verifies a standard ed25519 signature against the stealth public key.
 * Works with signatures produced by signWithStealthKey/proveOwnership.
 *
 * @param stealthPubKey - The 32-byte stealth public key (scalar * G)
 * @param challenge - The challenge that was signed
 * @param signature - The 64-byte signature to verify
 * @returns True if the signature is valid, false otherwise
 */
export function verifyOwnership(
  stealthPubKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array,
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
    return ed25519.verify(signature, challenge, stealthPubKey);
  } catch {
    return false;
  }
}
