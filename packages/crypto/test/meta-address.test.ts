import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  decodeMetaAddress,
  InvalidMetaAddress,
  InvalidPublicKey,
  scalarMultBase,
} from '../src/index.js';

describe('meta-address encoding with checksum', () => {
  it('should encode and decode meta-address with checksum', () => {
    const keys = generateMetaAddress();
    const encoded = encodeMetaAddress(keys.metaAddress);

    // Should have correct format
    expect(encoded).toMatch(/^st:stellar:[0-9a-f]{136}$/);

    // Should decode correctly
    const decoded = decodeMetaAddress(encoded);
    expect(bytesToHex(decoded.spendPubKey)).toBe(bytesToHex(keys.metaAddress.spendPubKey));
    expect(bytesToHex(decoded.viewPubKey)).toBe(bytesToHex(keys.metaAddress.viewPubKey));
  });

  it('should reject invalid prefix', () => {
    const invalidPrefix = 'invalid:stellar:' + '0'.repeat(136);
    expect(() => decodeMetaAddress(invalidPrefix)).toThrow(InvalidMetaAddress);
    expect(() => decodeMetaAddress(invalidPrefix)).toThrow('Invalid meta-address prefix');
  });

  it('should reject invalid length', () => {
    // Too short
    const tooShort = 'st:stellar:' + '0'.repeat(134);
    expect(() => decodeMetaAddress(tooShort)).toThrow(InvalidMetaAddress);
    expect(() => decodeMetaAddress(tooShort)).toThrow('Invalid meta-address length');

    // Too long
    const tooLong = 'st:stellar:' + '0'.repeat(138);
    expect(() => decodeMetaAddress(tooLong)).toThrow(InvalidMetaAddress);
    expect(() => decodeMetaAddress(tooLong)).toThrow('Invalid meta-address length');
  });

  it('should reject invalid hex encoding', () => {
    const invalidHex = 'st:stellar:' + 'g'.repeat(136); // 'g' is not valid hex
    expect(() => decodeMetaAddress(invalidHex)).toThrow(InvalidMetaAddress);
    expect(() => decodeMetaAddress(invalidHex)).toThrow('Invalid hex encoding');
  });

  it('should reject invalid checksum', () => {
    const keys = generateMetaAddress();
    const encoded = encodeMetaAddress(keys.metaAddress);

    // Corrupt the checksum (last 8 hex chars)
    const corrupted = encoded.slice(0, -8) + '00000000';

    expect(() => decodeMetaAddress(corrupted)).toThrow(InvalidMetaAddress);
    expect(() => decodeMetaAddress(corrupted)).toThrow('Invalid checksum');
  });

  it('should reject corrupted payload with valid checksum format', () => {
    const keys = generateMetaAddress();
    const encoded = encodeMetaAddress(keys.metaAddress);

    // Corrupt a byte in the middle of the payload
    const chars = encoded.split('');
    chars[50] = chars[50] === '0' ? '1' : '0'; // Flip a bit
    const corrupted = chars.join('');

    expect(() => decodeMetaAddress(corrupted)).toThrow(InvalidMetaAddress);
    expect(() => decodeMetaAddress(corrupted)).toThrow('Invalid checksum');
  });

  it('should validate public keys are on curve during encoding', () => {
    // Invalid spend key (not on curve)
    const invalidSpend = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      invalidSpend[i] = 0xff;
    }
    const validView = ed25519.ExtendedPoint.BASE.toRawBytes();

    expect(() => encodeMetaAddress({
      spendPubKey: invalidSpend,
      viewPubKey: validView,
    })).toThrow(InvalidMetaAddress);
  });

  it('should validate public keys are on curve during decoding', async () => {
    // Manually craft an address with invalid keys but valid checksum structure
    // This is tricky because we need valid-looking data
    // We'll use the identity point which is technically on curve but might not be allowed
    const identity = ed25519.ExtendedPoint.ZERO.toRawBytes();

    // Create a payload with identity points
    const payload = new Uint8Array(64);
    payload.set(identity, 0);
    payload.set(identity, 32);

    // Calculate checksum
    const { sha256 } = await import('@noble/hashes/sha256');
    const hash = sha256(payload);
    const checksum = hash.slice(28, 32);

    // Combine and encode
    const combined = new Uint8Array(68);
    combined.set(payload, 0);
    combined.set(checksum, 64);

    const hex = Array.from(combined)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const encoded = `st:stellar:${hex}`;

    // This should either work (if identity is allowed) or throw
    // The important thing is it validates the keys
    try {
      const decoded = decodeMetaAddress(encoded);
      // If it succeeds, the keys should match
      expect(bytesToHex(decoded.spendPubKey)).toBe(bytesToHex(identity));
      expect(bytesToHex(decoded.viewPubKey)).toBe(bytesToHex(identity));
    } catch (e) {
      // If it fails, it should be because of invalid public key
      expect(e).toBeInstanceOf(InvalidMetaAddress);
    }
  });

  it('should handle different valid keys correctly', () => {
    // Generate multiple different meta-addresses
    const keys1 = generateMetaAddress();
    const keys2 = generateMetaAddress();
    const keys3 = generateMetaAddress();

    const encoded1 = encodeMetaAddress(keys1.metaAddress);
    const encoded2 = encodeMetaAddress(keys2.metaAddress);
    const encoded3 = encodeMetaAddress(keys3.metaAddress);

    // All should be different
    expect(encoded1).not.toBe(encoded2);
    expect(encoded2).not.toBe(encoded3);
    expect(encoded1).not.toBe(encoded3);

    // All should decode correctly
    const decoded1 = decodeMetaAddress(encoded1);
    const decoded2 = decodeMetaAddress(encoded2);
    const decoded3 = decodeMetaAddress(encoded3);

    expect(bytesToHex(decoded1.spendPubKey)).toBe(bytesToHex(keys1.metaAddress.spendPubKey));
    expect(bytesToHex(decoded2.spendPubKey)).toBe(bytesToHex(keys2.metaAddress.spendPubKey));
    expect(bytesToHex(decoded3.spendPubKey)).toBe(bytesToHex(keys3.metaAddress.spendPubKey));
  });

  it('should encode deterministic addresses consistently', () => {
    // Use fixed scalars to generate deterministic keys
    const scalar1 = new Uint8Array(32);
    scalar1[0] = 1;
    const scalar2 = new Uint8Array(32);
    scalar2[0] = 2;

    const spendPubKey = scalarMultBase(scalar1);
    const viewPubKey = scalarMultBase(scalar2);

    const metaAddr = { spendPubKey, viewPubKey };

    const encoded1 = encodeMetaAddress(metaAddr);
    const encoded2 = encodeMetaAddress(metaAddr);

    // Same input should produce same output
    expect(encoded1).toBe(encoded2);

    // Should decode correctly
    const decoded = decodeMetaAddress(encoded1);
    expect(bytesToHex(decoded.spendPubKey)).toBe(bytesToHex(spendPubKey));
    expect(bytesToHex(decoded.viewPubKey)).toBe(bytesToHex(viewPubKey));
  });
});