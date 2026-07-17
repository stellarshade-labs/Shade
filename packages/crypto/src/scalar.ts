import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { L, scalarMultBase } from './ed25519.js';
import { InvalidScalar } from './errors.js';

/**
 * Sign a message with a raw 32-byte ed25519 scalar — the signing core shared
 * by {@link StealthScalar.sign} and `signWithStealthKey`'s deprecated
 * raw-bytes path. Module-internal: not re-exported from the package index.
 *
 * Standard ed25519.sign() hashes a SEED to derive the signing scalar, but
 * stealth private keys are already raw scalars from modular addition
 * (k_spend + s mod L). This constructs a valid ed25519 signature directly
 * from the raw scalar, producing signatures that verify with standard
 * ed25519.verify() against the corresponding public key (scalar * G).
 *
 * @param message - The message to sign
 * @param privateScalar - 32-byte raw scalar (stealth private key)
 * @returns 64-byte ed25519 signature (R || S)
 */
export function signWithRawScalarBytes(
  message: Uint8Array,
  privateScalar: Uint8Array,
): Uint8Array {
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

  // Zero the sensitive intermediate (contains the private scalar).
  nonceInput.fill(0);

  const R = ed25519.ExtendedPoint.BASE.multiply(r);
  const Rbytes = R.toRawBytes();

  // Challenge: k = SHA-512(R || pubKey || message) mod L
  const challengeInput = new Uint8Array(32 + 32 + message.length);
  challengeInput.set(Rbytes, 0);
  challengeInput.set(pubKeyBytes, 32);
  challengeInput.set(message, 64);
  const k = bytesToNumberLE(sha512(challengeInput)) % L;

  // challengeInput holds only public data (R, pubKey, message); zeroing it is
  // uniform zeroization hygiene, not a secrecy requirement.
  challengeInput.fill(0);

  // Response: S = (r + k * a) mod L
  const S = (r + k * a) % L;

  const sig = new Uint8Array(64);
  sig.set(Rbytes, 0);
  sig.set(numberToBytesLE(S, 32), 32);
  return sig;
}

/**
 * A recovered stealth private key: a raw ed25519 SCALAR (k_spend + s mod L),
 * wrapped so it can only be used correctly.
 *
 * WHY A CLASS AND NOT A `Uint8Array`: a raw scalar is NOT an ed25519 seed.
 * Every seed-based keypair API — `Keypair.fromRawEd25519Seed()`,
 * `ed25519.sign()`, wallet imports — HASHES its input to derive a different
 * signing scalar, producing a keypair whose public key does not match the
 * stealth address. Signatures from such a keypair are rejected on-chain and
 * the funds become PERMANENTLY UNWITHDRAWABLE. Because this wrapper is not
 * structurally a `Uint8Array` (the private field makes it incompatible),
 * `Keypair.fromRawEd25519Seed(scalar)` and `Buffer.from(scalar)` are compile
 * errors instead of silent fund loss.
 *
 * Use {@link sign} to sign, {@link publicKey} to verify correspondence with
 * the stealth address, and {@link zeroize} to clear the key from memory once
 * done. {@link dangerouslyToRawBytes} is the explicit, misuse-warned escape
 * hatch for raw-scalar interop.
 */
export class StealthScalar {
  /** Private field: invisible to structural typing, inaccessible outside. */
  #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /**
   * Wrap a raw 32-byte ed25519 scalar (interop/tests). The bytes are
   * defensively copied — mutating (or zeroing) the input afterwards does not
   * affect the wrapper, and vice versa.
   *
   * @param bytes - 32-byte raw scalar (little-endian)
   * @throws {InvalidScalar} If `bytes` is not exactly 32 bytes.
   */
  static fromBytes(bytes: Uint8Array): StealthScalar {
    if (bytes.length !== 32) {
      throw new InvalidScalar('Invalid stealth private key length');
    }
    return new StealthScalar(new Uint8Array(bytes));
  }

  /** Throw if the scalar has been zeroized (an all-zero scalar is never valid). */
  #assertLive(): void {
    if (this.#bytes.every((b) => b === 0)) {
      throw new InvalidScalar(
        'Stealth scalar is all-zero (already zeroized?) — it can no longer be used',
      );
    }
  }

  /**
   * Sign a message with the wrapped raw scalar. Produces a standard ed25519
   * signature that verifies against {@link publicKey} (scalar * G).
   *
   * @param message - The message to sign (must be non-empty)
   * @returns 64-byte ed25519 signature (R || S)
   * @throws {InvalidScalar} If the scalar has been {@link zeroize}d.
   */
  sign(message: Uint8Array): Uint8Array {
    this.#assertLive();
    return signWithRawScalarBytes(message, this.#bytes);
  }

  /**
   * The stealth public key this scalar signs for (scalar * G). Compare it to
   * the announced stealth public key to verify correspondence.
   *
   * @throws {InvalidScalar} If the scalar has been {@link zeroize}d.
   */
  publicKey(): Uint8Array {
    this.#assertLive();
    return scalarMultBase(this.#bytes);
  }

  /**
   * Overwrite the wrapped scalar with zeros. Call once you are done signing;
   * any later {@link sign}/{@link publicKey}/{@link dangerouslyToRawBytes}
   * throws instead of operating on a dead key. Idempotent.
   */
  zeroize(): void {
    this.#bytes.fill(0);
  }

  /**
   * DANGER — escape hatch returning a copy of the raw 32-byte scalar. Misuse
   * of these bytes permanently destroys funds:
   *
   * The value is a raw ed25519 SCALAR, **not an ed25519 seed**. Seed-based
   * Keypair APIs (`Keypair.fromRawEd25519Seed()`, `ed25519.sign()`, wallet
   * key imports) HASH the input to derive a different signing scalar, so the
   * resulting keypair's public key does NOT match the stealth address — the
   * contract/network rejects its signatures and the funds at that address
   * become PERMANENTLY UNWITHDRAWABLE.
   *
   * Only pass these bytes to APIs that consume raw scalars directly (e.g. the
   * deprecated `signWithStealthKey(message, rawBytes)` overload). Prefer
   * {@link sign}/{@link publicKey}, and zero any copy you make (`copy.fill(0)`)
   * as soon as you are done with it.
   *
   * @returns A fresh copy of the 32-byte raw scalar.
   * @throws {InvalidScalar} If the scalar has been {@link zeroize}d.
   */
  dangerouslyToRawBytes(): Uint8Array {
    this.#assertLive();
    return new Uint8Array(this.#bytes);
  }
}
