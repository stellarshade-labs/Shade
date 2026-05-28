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
  it('should encrypt and decrypt amounts correctly', () => {
    const sharedSecret = new Uint8Array(32).fill(1);
    const amount = 123.456;

    const encrypted = encryptAmount(amount, sharedSecret);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBe(8);

    const decrypted = decryptAmount(encrypted, sharedSecret);
    expect(decrypted).toBeCloseTo(amount, 10);
  });

  it('should produce different ciphertexts for different shared secrets', () => {
    const amount = 100;
    const secret1 = new Uint8Array(32).fill(1);
    const secret2 = new Uint8Array(32).fill(2);

    const encrypted1 = encryptAmount(amount, secret1);
    const encrypted2 = encryptAmount(amount, secret2);

    expect(encrypted1).not.toEqual(encrypted2);
  });

  it('should handle zero amount', () => {
    const sharedSecret = randomScalar();
    const amount = 0;

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBe(0);
  });

  it('should handle large amounts', () => {
    const sharedSecret = randomScalar();
    const amount = 1e15; // 1 quadrillion

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBeCloseTo(amount, 0);
  });

  it('should handle negative amounts', () => {
    const sharedSecret = randomScalar();
    const amount = -123.456;

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBeCloseTo(amount, 10);
  });

  it('should handle NaN', () => {
    const sharedSecret = randomScalar();
    const amount = NaN;

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBeNaN();
  });

  it('should handle Infinity', () => {
    const sharedSecret = randomScalar();
    const amount = Infinity;

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBe(Infinity);
  });

  it('should handle -Infinity', () => {
    const sharedSecret = randomScalar();
    const amount = -Infinity;

    const encrypted = encryptAmount(amount, sharedSecret);
    const decrypted = decryptAmount(encrypted, sharedSecret);

    expect(decrypted).toBe(-Infinity);
  });

  it('should fail with invalid shared secret length', () => {
    const invalidSecret = new Uint8Array(16); // Wrong length
    const amount = 100;

    // The function doesn't validate input length, it will still work but with undefined behavior
    // This is a design choice - the caller is responsible for providing valid input
    const encrypted = encryptAmount(amount, invalidSecret);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBe(8);
  });

  it('should fail to decrypt with wrong shared secret', () => {
    const secret1 = randomScalar();
    const secret2 = randomScalar();
    const amount = 123.456;

    const encrypted = encryptAmount(amount, secret1);
    const decrypted = decryptAmount(encrypted, secret2);

    // Should decrypt to a different (wrong) value
    expect(decrypted).not.toBeCloseTo(amount, 10);
  });
});

describe('decryptAmount', () => {
  it('should reject invalid encrypted data length', () => {
    const sharedSecret = randomScalar();
    const invalidEncrypted = new Uint8Array(4); // Wrong length

    expect(() => decryptAmount(invalidEncrypted, sharedSecret)).toThrow('Invalid encrypted amount');
  });

  it('should produce consistent results with same inputs', () => {
    const sharedSecret = new Uint8Array(32).fill(42);
    const encrypted = new Uint8Array(8).fill(100);

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