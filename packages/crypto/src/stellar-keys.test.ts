import { describe, it, expect } from 'vitest';
import { encodePublicKey, decodePublicKey } from './stellar-keys.js';
import { randomBytes } from '@noble/hashes/utils';

describe('stellar-keys', () => {
  describe('encodePublicKey', () => {
    it('should encode a 32-byte public key to Stellar address', () => {
      const pubKey = new Uint8Array(32).fill(1);
      const address = encodePublicKey(pubKey);

      expect(address).toBeTruthy();
      expect(address).toMatch(/^G[A-Z2-7]+$/);
      expect(address.length).toBe(56); // Standard Stellar address length
    });

    it('should produce different addresses for different keys', () => {
      const pubKey1 = new Uint8Array(32).fill(1);
      const pubKey2 = new Uint8Array(32).fill(2);

      const address1 = encodePublicKey(pubKey1);
      const address2 = encodePublicKey(pubKey2);

      expect(address1).not.toBe(address2);
    });

    it('should throw error for invalid key length', () => {
      const shortKey = new Uint8Array(16);
      const longKey = new Uint8Array(64);

      expect(() => encodePublicKey(shortKey)).toThrow('Public key must be 32 bytes');
      expect(() => encodePublicKey(longKey)).toThrow('Public key must be 32 bytes');
    });

    it('should handle zero public key', () => {
      const pubKey = new Uint8Array(32); // All zeros
      const address = encodePublicKey(pubKey);

      expect(address).toMatch(/^G[A-Z2-7]+$/);
      expect(address.length).toBe(56);
    });

    it('should handle max value public key', () => {
      const pubKey = new Uint8Array(32).fill(255);
      const address = encodePublicKey(pubKey);

      expect(address).toMatch(/^G[A-Z2-7]+$/);
      expect(address.length).toBe(56);
    });
  });

  describe('decodePublicKey', () => {
    it('should decode a valid Stellar address', () => {
      const originalKey = randomBytes(32);
      const address = encodePublicKey(originalKey);
      const decodedKey = decodePublicKey(address);

      expect(decodedKey).toEqual(originalKey);
    });

    it('should throw error for non-G addresses', () => {
      expect(() => decodePublicKey('SABC123')).toThrow('Invalid Stellar address: must start with G');
      expect(() => decodePublicKey('HABC123')).toThrow('Invalid Stellar address: must start with G');
      expect(() => decodePublicKey('ABC123')).toThrow('Invalid Stellar address: must start with G');
    });

    it('should throw error for invalid base32 characters', () => {
      const invalidAddress = 'G0189ABC'; // 0, 1, 8, 9 are not in base32
      expect(() => decodePublicKey(invalidAddress)).toThrow('Invalid base32 character');
    });

    it('should throw error for incorrect length', () => {
      const shortAddress = 'GABC';
      const longAddress = 'G' + 'A'.repeat(100);

      expect(() => decodePublicKey(shortAddress)).toThrow('Invalid Stellar address: incorrect length');
      expect(() => decodePublicKey(longAddress)).toThrow('Invalid Stellar address: incorrect length');
    });

    it('should throw error for invalid checksum', () => {
      // Take a valid address and corrupt the last character
      const validKey = new Uint8Array(32).fill(42);
      const validAddress = encodePublicKey(validKey);
      const corruptedAddress = validAddress.slice(0, -1) + (validAddress.slice(-1) === 'A' ? 'B' : 'A');

      expect(() => decodePublicKey(corruptedAddress)).toThrow('Invalid Stellar address: checksum mismatch');
    });

    it('should handle known test vectors', () => {
      // Test with a known public key
      const pubKey = new Uint8Array(32);
      pubKey[0] = 0x01;
      pubKey[31] = 0xFF;

      const address = encodePublicKey(pubKey);
      const decoded = decodePublicKey(address);

      expect(decoded).toEqual(pubKey);
    });
  });

  describe('roundtrip encode/decode', () => {
    it('should successfully roundtrip random keys', () => {
      for (let i = 0; i < 100; i++) {
        const originalKey = randomBytes(32);
        const address = encodePublicKey(originalKey);
        const decodedKey = decodePublicKey(address);

        expect(decodedKey).toEqual(originalKey);
      }
    });

    it('should handle edge case byte values', () => {
      // Test all single-byte patterns
      for (let byteValue = 0; byteValue <= 255; byteValue++) {
        const pubKey = new Uint8Array(32).fill(byteValue);
        const address = encodePublicKey(pubKey);
        const decoded = decodePublicKey(address);

        expect(decoded).toEqual(pubKey);
      }
    });

    it('should handle keys with specific patterns', () => {
      // Ascending pattern
      const ascendingKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        ascendingKey[i] = i;
      }

      const addr1 = encodePublicKey(ascendingKey);
      expect(decodePublicKey(addr1)).toEqual(ascendingKey);

      // Descending pattern
      const descendingKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        descendingKey[i] = 255 - i;
      }

      const addr2 = encodePublicKey(descendingKey);
      expect(decodePublicKey(addr2)).toEqual(descendingKey);

      // Alternating pattern
      const alternatingKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        alternatingKey[i] = i % 2 === 0 ? 0x55 : 0xAA;
      }

      const addr3 = encodePublicKey(alternatingKey);
      expect(decodePublicKey(addr3)).toEqual(alternatingKey);
    });
  });

  describe('compatibility', () => {
    it('should produce valid Stellar addresses starting with G', () => {
      // Test multiple random keys
      for (let i = 0; i < 10; i++) {
        const pubKey = randomBytes(32);
        const address = encodePublicKey(pubKey);

        expect(address[0]).toBe('G');
        expect(address).toMatch(/^G[A-Z2-7]{55}$/);
      }
    });

    it('should handle empty input gracefully', () => {
      // @ts-ignore - Testing invalid input
      expect(() => encodePublicKey()).toThrow();
      // @ts-ignore - Testing invalid input
      expect(() => encodePublicKey(null)).toThrow();
      // @ts-ignore - Testing invalid input
      expect(() => encodePublicKey(undefined)).toThrow();

      expect(() => decodePublicKey('')).toThrow('Invalid Stellar address: must start with G');
      // @ts-ignore - Testing invalid input
      expect(() => decodePublicKey(null)).toThrow();
      // @ts-ignore - Testing invalid input
      expect(() => decodePublicKey(undefined)).toThrow();
    });
  });
});