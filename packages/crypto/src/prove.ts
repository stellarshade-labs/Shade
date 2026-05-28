import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { L, scalarMultBase } from './ed25519.js';

/**
 * Sign a message using a raw ed25519 scalar (stealth private key).
 *
 * Standard ed25519.sign() hashes the seed to derive the signing scalar,
 * but stealth private keys are already raw scalars from modular addition
 * (k_spend + s mod L). This function constructs a valid ed25519 signature
 * directly from the raw scalar, producing signatures that verify with
 * standard ed25519.verify() against the corresponding public key (scalar * G).
 *
 * @param message - The message to sign
 * @param privateScalar - 32-byte raw scalar (stealth private key)
 * @returns 64-byte ed25519 signature (R || S)
 */
export function signWithStealthKey(message: Uint8Array, privateScalar: Uint8Array): Uint8Array {
  if (privateScalar.length !== 32) {
    throw new Error('Invalid stealth private key length');
  }
  if (message.length === 0) {
    throw new Error('Message cannot be empty');
  }

  const a = bytesToNumberLE(privateScalar) % L;
  const pubKeyBytes = scalarMultBase(privateScalar);

  // Deterministic nonce: r = SHA-512(privateScalar || message) mod L
  const nonceInput = new Uint8Array(32 + message.length);
  nonceInput.set(privateScalar, 0);
  nonceInput.set(message, 32);
  const r = bytesToNumberLE(sha512(nonceInput)) % L;

  const R = ed25519.ExtendedPoint.BASE.multiply(r);
  const Rbytes = R.toRawBytes();

  // Challenge: k = SHA-512(R || pubKey || message) mod L
  const challengeInput = new Uint8Array(32 + 32 + message.length);
  challengeInput.set(Rbytes, 0);
  challengeInput.set(pubKeyBytes, 32);
  challengeInput.set(message, 64);
  const k = bytesToNumberLE(sha512(challengeInput)) % L;

  // Response: S = (r + k * a) mod L
  const S = (r + k * a) % L;

  const sig = new Uint8Array(64);
  sig.set(Rbytes, 0);
  sig.set(numberToBytesLE(S, 32), 32);
  return sig;
}

/**
 * Prove ownership of a stealth address by signing a challenge.
 *
 * Uses raw-scalar ed25519 signing so the signature verifies against
 * the stealth public key (privateScalar * G), not the hashed-seed public key.
 *
 * @param stealthPrivKey - The 32-byte stealth private key (raw scalar)
 * @param challenge - The challenge to sign (typically a nonce or timestamp)
 * @returns The 64-byte ed25519 signature
 * @throws {Error} If private key is not 32 bytes or challenge is empty
 */
export function proveOwnership(
  stealthPrivKey: Uint8Array,
  challenge: Uint8Array
): Uint8Array {
  return signWithStealthKey(challenge, stealthPrivKey);
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