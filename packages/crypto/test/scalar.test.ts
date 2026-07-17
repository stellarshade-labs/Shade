import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { generateMetaAddress } from '../src/keys.js';
import { deriveStealthAddress } from '../src/stealth.js';
import {
  recoverStealthPrivateKey,
  recoverStealthPrivateKeyBytes,
} from '../src/recover.js';
import { StealthScalar } from '../src/scalar.js';
import { signWithStealthKey } from '../src/prove.js';
import { scalarMultBase, generateRandomScalar } from '../src/ed25519.js';

/** Recover a fresh (keys, derivation, scalar) fixture for each test. */
function recoverFixture(): {
  scalar: StealthScalar;
  stealthPubKey: Uint8Array;
} {
  const keys = generateMetaAddress();
  const derivation = deriveStealthAddress(keys.metaAddress);
  const scalar = recoverStealthPrivateKey(
    keys.spendPrivKey,
    keys.viewPrivKey,
    derivation.ephemeralPubKey,
  );
  return { scalar, stealthPubKey: derivation.stealthPubKey };
}

describe('StealthScalar', () => {
  it('fromBytes enforces the 32-byte length', () => {
    expect(() => StealthScalar.fromBytes(new Uint8Array(31))).toThrow();
    expect(() => StealthScalar.fromBytes(new Uint8Array(33))).toThrow();
    expect(() => StealthScalar.fromBytes(new Uint8Array(0))).toThrow();
    expect(StealthScalar.fromBytes(generateRandomScalar())).toBeInstanceOf(
      StealthScalar,
    );
  });

  it('fromBytes copies its input (later mutation does not corrupt the scalar)', () => {
    const raw = generateRandomScalar();
    const scalar = StealthScalar.fromBytes(raw);
    const before = scalar.publicKey();
    raw.fill(0);
    expect(scalar.publicKey()).toEqual(before);
  });

  it('publicKey() matches the announced stealth public key', () => {
    const { scalar, stealthPubKey } = recoverFixture();
    expect(scalar.publicKey()).toEqual(stealthPubKey);
  });

  it('sign() produces a signature that verifies against publicKey()', () => {
    const { scalar, stealthPubKey } = recoverFixture();
    const message = new TextEncoder().encode('withdraw_message');
    const sig = scalar.sign(message);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, message, stealthPubKey)).toBe(true);
  });

  it('sign() after zeroize() throws (an all-zero scalar is never valid)', () => {
    const { scalar } = recoverFixture();
    const message = new Uint8Array([1, 2, 3]);
    expect(scalar.sign(message)).toHaveLength(64);
    scalar.zeroize();
    expect(() => scalar.sign(message)).toThrow();
    expect(() => scalar.publicKey()).toThrow();
    expect(() => scalar.dangerouslyToRawBytes()).toThrow();
    // Idempotent: a second zeroize neither throws nor revives the key.
    scalar.zeroize();
    expect(() => scalar.sign(message)).toThrow();
  });

  it('dangerouslyToRawBytes returns the scalar that verifies against publicKey()', () => {
    const { scalar, stealthPubKey } = recoverFixture();
    const raw = scalar.dangerouslyToRawBytes();

    // The escaped raw scalar derives the same public key...
    expect(scalarMultBase(raw)).toEqual(scalar.publicKey());
    // ...and signatures made from the raw bytes (deprecated raw path) verify
    // against the wrapper's public key / the announced stealth key.
    const message = new TextEncoder().encode('raw-scalar interop');
    const rawSig = signWithStealthKey(message, raw);
    expect(ed25519.verify(rawSig, message, scalar.publicKey())).toBe(true);
    expect(ed25519.verify(rawSig, message, stealthPubKey)).toBe(true);
  });

  it('dangerouslyToRawBytes returns a copy (zeroing it leaves the wrapper live)', () => {
    const { scalar } = recoverFixture();
    const raw = scalar.dangerouslyToRawBytes();
    raw.fill(0);
    expect(() => scalar.sign(new Uint8Array([9]))).not.toThrow();
  });

  it('signWithStealthKey accepts both the wrapper and (deprecated) raw bytes, byte-equal', () => {
    const { scalar } = recoverFixture();
    const message = new TextEncoder().encode('both paths');
    const viaWrapper = signWithStealthKey(message, scalar);
    const viaMethod = scalar.sign(message);
    const viaRaw = signWithStealthKey(message, scalar.dangerouslyToRawBytes());
    // Deterministic nonce => identical signatures across all three paths.
    expect(viaWrapper).toEqual(viaMethod);
    expect(viaRaw).toEqual(viaWrapper);
  });

  it('deprecated recoverStealthPrivateKeyBytes is byte-equal to dangerouslyToRawBytes', () => {
    const keys = generateMetaAddress();
    const derivation = deriveStealthAddress(keys.metaAddress);

    const viaWrapper = recoverStealthPrivateKey(
      keys.spendPrivKey,
      keys.viewPrivKey,
      derivation.ephemeralPubKey,
    ).dangerouslyToRawBytes();
    const viaAlias = recoverStealthPrivateKeyBytes(
      keys.spendPrivKey,
      keys.viewPrivKey,
      derivation.ephemeralPubKey,
    );

    expect(viaAlias).toEqual(viaWrapper);
    expect(viaAlias).toHaveLength(32);
    // And the alias' bytes still sign correctly via the deprecated raw path.
    const message = new Uint8Array([42]);
    const sig = signWithStealthKey(message, viaAlias);
    expect(ed25519.verify(sig, message, derivation.stealthPubKey)).toBe(true);
  });

  it('is structurally incompatible with Uint8Array (no index/length surface)', () => {
    const { scalar } = recoverFixture();
    // Runtime shape check backing the compile-time guarantee: none of the
    // Uint8Array surface exists, so Buffer.from(scalar)/seed APIs cannot
    // silently consume a wrapper.
    expect(scalar).not.toBeInstanceOf(Uint8Array);
    expect((scalar as unknown as { length?: number }).length).toBeUndefined();
    expect((scalar as unknown as { fill?: unknown }).fill).toBeUndefined();
  });
});
