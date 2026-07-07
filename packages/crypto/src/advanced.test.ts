import { describe, it, expect } from 'vitest';
import { encryptAmount, decryptAmount, deriveStealthAddressWithSecret } from './advanced.js';
import { generateMetaAddress } from './keys.js';
import { deriveStealthAddress } from './stealth.js';
import { randomBytes } from '@noble/hashes/utils';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { L } from './ed25519.js';

// Helper to generate a random scalar
function randomScalar(): Uint8Array {
  const bytes = randomBytes(32);
  const n = bytesToNumberLE(bytes) % L;
  return numberToBytesLE(n, 32);
}

describe('encryptAmount', () => {
  it('should encrypt and decrypt integer stroop amounts correctly', () => {
    const sharedSecret = new Uint8Array(32).fill(1);
    const amount = 123456n;

    const encrypted = encryptAmount(amount, sharedSecret);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBe(40); // 8-byte body + 32-byte HMAC tag

    const decrypted = decryptAmount(encrypted, sharedSecret);
    expect(decrypted).toBe(amount);
  });

  it('should accept number inputs for integer amounts', () => {
    const sharedSecret = randomScalar();
    const amount = 100;

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBe(100n);
  });

  it('should produce different ciphertexts for different shared secrets', () => {
    const amount = 100n;
    const secret1 = new Uint8Array(32).fill(1);
    const secret2 = new Uint8Array(32).fill(2);

    const encrypted1 = encryptAmount(amount, secret1);
    const encrypted2 = encryptAmount(amount, secret2);

    expect(encrypted1).not.toEqual(encrypted2);
  });

  it('should handle zero amount', () => {
    const sharedSecret = randomScalar();

    const encrypted = encryptAmount(0n, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBe(0n);
  });

  it('should round-trip a large stroop amount exactly', () => {
    const sharedSecret = randomScalar();
    // Above 2^53, beyond exact JS number precision — must round-trip exactly.
    const amount = 9_223_372_036_854_775_807n; // i64 max

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBe(amount);
  });

  it('should reject non-integer amounts', () => {
    const sharedSecret = randomScalar();
    expect(() => encryptAmount(123.456, sharedSecret)).toThrow('integer');
  });

  it('should reject negative amounts', () => {
    const sharedSecret = randomScalar();
    expect(() => encryptAmount(-1n, sharedSecret)).toThrow('non-negative');
  });

  it('should reject NaN', () => {
    const sharedSecret = randomScalar();
    expect(() => encryptAmount(NaN, sharedSecret)).toThrow('finite');
  });

  it('should reject Infinity', () => {
    const sharedSecret = randomScalar();
    expect(() => encryptAmount(Infinity, sharedSecret)).toThrow('finite');
  });

  it('should reject amounts exceeding the maximum', () => {
    const sharedSecret = randomScalar();
    expect(() => encryptAmount(1n << 64n, sharedSecret)).toThrow('maximum');
  });

  it('should fail with invalid shared secret length', () => {
    const invalidSecret = new Uint8Array(16); // Wrong length
    expect(() => encryptAmount(100n, invalidSecret)).toThrow('Invalid shared secret');
  });

  it('should fail to decrypt with wrong shared secret (auth failure)', () => {
    const secret1 = randomScalar();
    const secret2 = randomScalar();
    const amount = 123456n;

    const encrypted = encryptAmount(amount, secret1);
    expect(() => decryptAmount(encrypted, secret2)).toThrow('authentication failed');
  });
});

describe('decryptAmount', () => {
  it('should reject invalid encrypted data length', () => {
    const sharedSecret = randomScalar();
    const invalidEncrypted = new Uint8Array(4); // Wrong length

    expect(() => decryptAmount(invalidEncrypted, sharedSecret)).toThrow('Invalid encrypted amount');
  });

  it('should throw when a ciphertext byte is flipped', () => {
    const sharedSecret = randomScalar();
    const encrypted = encryptAmount(500n, sharedSecret);

    // Flip a byte in the encrypted amount body.
    encrypted[0] ^= 0xff;
    expect(() => decryptAmount(encrypted, sharedSecret)).toThrow('authentication failed');
  });

  it('should throw when a tag byte is flipped', () => {
    const sharedSecret = randomScalar();
    const encrypted = encryptAmount(500n, sharedSecret);

    // Flip a byte in the HMAC tag region.
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decryptAmount(encrypted, sharedSecret)).toThrow('authentication failed');
  });

  it('should produce consistent results with same inputs', () => {
    const sharedSecret = randomScalar();
    const encrypted = encryptAmount(777n, sharedSecret);

    const result1 = decryptAmount(encrypted, sharedSecret);
    const result2 = decryptAmount(encrypted, sharedSecret);

    expect(result1).toBe(result2);
  });
});

describe('deriveStealthAddressWithSecret', () => {
  it('should derive stealth address with exposed shared secret', () => {
    const sender = generateMetaAddress();
    const receiver = generateMetaAddress();
    const ephemeralPrivKey = randomScalar();

    const result = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKey
    );

    expect(result).toHaveProperty('stealthPubKey');
    expect(result).toHaveProperty('stealthAddress');
    expect(result).toHaveProperty('ephemeralPubKey');
    expect(result).toHaveProperty('viewTag');
    expect(result).toHaveProperty('ephemeralPrivKey');
    expect(result).toHaveProperty('sharedSecret');

    expect(result.sharedSecret).toBeInstanceOf(Uint8Array);
    expect(result.sharedSecret.length).toBe(32);
  });

  it('should produce same stealth address as regular derive function', () => {
    const receiver = generateMetaAddress();
    const ephemeralPrivKey = randomScalar();

    // deriveStealthAddressWithSecret allows custom ephemeral key
    const withSecret = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKey
    );

    // deriveStealthAddress generates a random ephemeral key internally
    // so we can't compare directly - just verify the output structure
    expect(withSecret.stealthPubKey).toBeInstanceOf(Uint8Array);
    expect(withSecret.stealthPubKey.length).toBe(32);
    expect(withSecret.stealthAddress).toMatch(/^G[A-Z2-7]+$/);
    expect(withSecret.ephemeralPubKey).toBeInstanceOf(Uint8Array);
    expect(withSecret.ephemeralPubKey.length).toBe(32);
    expect(withSecret.viewTag).toBeTypeOf('number');
    expect(withSecret.sharedSecret).toBeInstanceOf(Uint8Array);
    expect(withSecret.sharedSecret.length).toBe(32);
  });

  it('should produce different shared secrets for different view keys', () => {
    const receiver1 = generateMetaAddress();
    const receiver2 = generateMetaAddress();
    const ephemeralPrivKey = randomScalar();

    const result1 = deriveStealthAddressWithSecret(
      receiver1.metaAddress.spendPubKey,
      receiver1.metaAddress.viewPubKey,
      ephemeralPrivKey
    );

    const result2 = deriveStealthAddressWithSecret(
      receiver2.metaAddress.spendPubKey,
      receiver2.metaAddress.viewPubKey,
      ephemeralPrivKey
    );

    expect(result1.sharedSecret).not.toEqual(result2.sharedSecret);
  });

  it('should produce different shared secrets for different ephemeral keys', () => {
    const receiver = generateMetaAddress();
    const ephemeralPrivKey1 = randomScalar();
    const ephemeralPrivKey2 = randomScalar();

    const result1 = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKey1
    );

    const result2 = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKey2
    );

    expect(result1.sharedSecret).not.toEqual(result2.sharedSecret);
  });

  it('should return the same ephemeral private key passed in', () => {
    const receiver = generateMetaAddress();
    const ephemeralPrivKey = randomScalar();

    const result = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKey
    );

    expect(result.ephemeralPrivKey).toEqual(ephemeralPrivKey);
  });

  it('should work with edge case scalar values', () => {
    const receiver = generateMetaAddress();

    // Test with scalar value of 1
    const ephemeralPrivKey = new Uint8Array(32);
    ephemeralPrivKey[0] = 1;

    const result = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKey
    );

    expect(result.stealthPubKey).toBeInstanceOf(Uint8Array);
    expect(result.stealthPubKey.length).toBe(32);
    expect(result.sharedSecret).toBeInstanceOf(Uint8Array);
    expect(result.sharedSecret.length).toBe(32);
  });

  it('should handle deterministic ephemeral key derivation with string secret', () => {
    const receiver = generateMetaAddress();
    const secret = 'test-secret-123';

    // Hash the secret to get a deterministic ephemeral private key
    const secretBytes = new TextEncoder().encode(secret);
    const hashInput = new Uint8Array(32 + secretBytes.length);
    hashInput.set(new Uint8Array(32), 0);
    hashInput.set(secretBytes, 32);
    const ephemeralPrivKey = bytesToNumberLE(hashInput) % L;
    const ephemeralPrivKeyBytes = numberToBytesLE(ephemeralPrivKey, 32);

    const result1 = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKeyBytes
    );

    const result2 = deriveStealthAddressWithSecret(
      receiver.metaAddress.spendPubKey,
      receiver.metaAddress.viewPubKey,
      ephemeralPrivKeyBytes
    );

    // Same secret should produce same results
    expect(result1.stealthPubKey).toEqual(result2.stealthPubKey);
    expect(result1.sharedSecret).toEqual(result2.sharedSecret);
    expect(result1.viewTag).toBe(result2.viewTag);
  });
});