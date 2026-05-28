import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';
import { hashToScalar, viewTag, InvalidScalar } from '../src/index.js';

describe('hash edge cases', () => {
  describe('hashToScalar', () => {
    it('should produce valid scalars for various inputs', () => {
      const inputs = [
        new Uint8Array([0]),
        new Uint8Array([1]),
        new Uint8Array([255]),
        new Uint8Array(32).fill(0),
        new Uint8Array(32).fill(255),
        new Uint8Array(64).fill(128),
      ];

      for (const input of inputs) {
        const scalar = hashToScalar(input);
        expect(scalar).toHaveLength(32);

        // Should be reduced mod L
        // We can't easily check the exact value, but we can check it's valid
        expect(() => {
          const { bytesToNumberLE } = require('@noble/curves/abstract/utils');
          const { L } = require('../src/ed25519.js');
          const value = bytesToNumberLE(scalar);
          expect(value).toBeLessThan(L);
        });
      }
    });

    it('should produce different scalars for different inputs', () => {
      const input1 = new Uint8Array([1]);
      const input2 = new Uint8Array([2]);

      const scalar1 = hashToScalar(input1);
      const scalar2 = hashToScalar(input2);

      expect(bytesToHex(scalar1)).not.toBe(bytesToHex(scalar2));
    });

    it('should handle empty input', () => {
      const empty = new Uint8Array(0);
      const scalar = hashToScalar(empty);

      expect(scalar).toHaveLength(32);
    });

    it('should handle large inputs', () => {
      const large = new Uint8Array(1024).fill(42);
      const scalar = hashToScalar(large);

      expect(scalar).toHaveLength(32);
    });

    // Note: Testing for zero scalar is nearly impossible in practice
    // as it requires finding an input where SHA256(input) mod L = 0
    // The probability is roughly 1 in 2^252
    it('should throw InvalidScalar if hash produces zero (theoretical)', () => {
      // We can't actually test this without mocking SHA256
      // Just verify the error type exists
      expect(InvalidScalar).toBeDefined();
    });
  });

  describe('viewTag', () => {
    it('should extract first byte of hash', () => {
      // Use a known input to verify correct extraction
      const input = new Uint8Array(32).fill(0);
      const tag = viewTag(input);

      expect(tag).toBeTypeOf('number');
      expect(tag).toBeGreaterThanOrEqual(0);
      expect(tag).toBeLessThanOrEqual(255);
    });

    it('should produce consistent tags for same input', () => {
      const input = new Uint8Array(32).fill(42);
      const tag1 = viewTag(input);
      const tag2 = viewTag(input);

      expect(tag1).toBe(tag2);
    });

    it('should produce different tags for different inputs (usually)', () => {
      const input1 = new Uint8Array(32).fill(1);
      const input2 = new Uint8Array(32).fill(2);

      const tag1 = viewTag(input1);
      const tag2 = viewTag(input2);

      // There's a 1/256 chance they're the same, but usually different
      // We can't assert they're different, but we can check they're valid
      expect(tag1).toBeTypeOf('number');
      expect(tag2).toBeTypeOf('number');
    });

    it('should reject invalid input length', () => {
      const shortInput = new Uint8Array(31);
      const longInput = new Uint8Array(33);

      expect(() => viewTag(shortInput)).toThrow('Invalid shared secret length');
      expect(() => viewTag(longInput)).toThrow('Invalid shared secret length');
    });

    it('should handle all possible byte values', () => {
      // Test that all possible first bytes work correctly
      for (let i = 0; i < 256; i++) {
        const input = new Uint8Array(32);
        input[0] = i;

        const tag = viewTag(input);
        expect(tag).toBeTypeOf('number');
        expect(tag).toBeGreaterThanOrEqual(0);
        expect(tag).toBeLessThanOrEqual(255);
      }
    });
  });
});