import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';
import {
  pointAdd,
  scalarMultBase,
  scalarMult,
  scalarAdd,
  validatePoint,
  L,
  PointAtInfinity,
  InvalidPublicKey,
  InvalidScalar,
} from '../src/index.js';

describe('ed25519 edge cases', () => {
  describe('point validation', () => {
    it('should validate valid points', () => {
      const G = ed25519.ExtendedPoint.BASE.toRawBytes();
      expect(() => validatePoint(G)).not.toThrow();
      expect(validatePoint(G)).toBe(true);
    });

    it('should reject invalid point lengths', () => {
      const shortPoint = new Uint8Array(31);
      const longPoint = new Uint8Array(33);

      expect(() => validatePoint(shortPoint)).toThrow(InvalidPublicKey);
      expect(() => validatePoint(longPoint)).toThrow(InvalidPublicKey);
    });

    it('should reject points not on curve', () => {
      // Random bytes unlikely to be on curve
      const invalidPoint = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        invalidPoint[i] = 0xff;
      }

      expect(() => validatePoint(invalidPoint)).toThrow(InvalidPublicKey);
    });
  });

  describe('point at infinity handling', () => {
    it('should throw PointAtInfinity when adding inverse points', () => {
      const G = ed25519.ExtendedPoint.BASE.toRawBytes();
      const negG = ed25519.ExtendedPoint.BASE.negate().toRawBytes();

      expect(() => pointAdd(G, negG)).toThrow(PointAtInfinity);
    });

    it('should handle zero scalar in scalarMultBase with allowZero flag', () => {
      const zero = new Uint8Array(32);

      // Should throw by default
      expect(() => scalarMultBase(zero)).toThrow(InvalidScalar);
      expect(() => scalarMultBase(zero)).toThrow('Zero scalar not allowed');

      // Should return identity with allowZero=true
      const result = scalarMultBase(zero, true);
      const identity = ed25519.ExtendedPoint.ZERO.toRawBytes();
      expect(bytesToHex(result)).toBe(bytesToHex(identity));
    });

    it('should handle zero scalar in scalarMult with allowZero flag', () => {
      const zero = new Uint8Array(32);
      const G = ed25519.ExtendedPoint.BASE.toRawBytes();

      // Should throw by default
      expect(() => scalarMult(zero, G)).toThrow(InvalidScalar);
      expect(() => scalarMult(zero, G)).toThrow('Zero scalar not allowed');

      // Should return identity with allowZero=true
      const result = scalarMult(zero, G, true);
      const identity = ed25519.ExtendedPoint.ZERO.toRawBytes();
      expect(bytesToHex(result)).toBe(bytesToHex(identity));
    });
  });

  describe('scalar edge cases', () => {
    it('should handle scalars modulo L correctly', () => {
      // Test with L itself (should become 0 mod L)
      const lBytes = new Uint8Array(32);
      // L in little-endian: edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010
      const lHex = 'edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010';
      const lArray = hexToBytes(lHex);
      lBytes.set(lArray);

      // L mod L = 0, so should throw without allowZero
      expect(() => scalarMultBase(lBytes)).toThrow(InvalidScalar);
    });

    it('should handle L+1 correctly', () => {
      // L+1 should become 1 mod L
      const lPlus1 = hexToBytes('eed3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
      const result = scalarMultBase(lPlus1);
      const expected = ed25519.ExtendedPoint.BASE.toRawBytes();
      expect(bytesToHex(result)).toBe(bytesToHex(expected));
    });

    it('should add scalars with wraparound correctly', () => {
      // (L-1) + 2 = 1 mod L
      const lMinus1 = hexToBytes('ecd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
      const two = new Uint8Array(32);
      two[0] = 2;

      const result = scalarAdd(lMinus1, two);
      const expected = new Uint8Array(32);
      expected[0] = 1;

      expect(bytesToHex(result)).toBe(bytesToHex(expected));
    });
  });

  describe('input validation', () => {
    it('should reject invalid scalar lengths', () => {
      const invalidScalar = new Uint8Array(31);
      const validPoint = new Uint8Array(32);

      expect(() => scalarMultBase(invalidScalar)).toThrow(InvalidScalar);
      expect(() => scalarMult(invalidScalar, validPoint)).toThrow(InvalidScalar);
      expect(() => scalarAdd(invalidScalar, validPoint)).toThrow(InvalidScalar);
      expect(() => scalarAdd(validPoint, invalidScalar)).toThrow(InvalidScalar);
    });

    it('should reject invalid point lengths in operations', () => {
      const validScalar = new Uint8Array(32);
      const invalidPoint = new Uint8Array(31);
      const validPoint = new Uint8Array(32);

      expect(() => scalarMult(validScalar, invalidPoint)).toThrow(InvalidPublicKey);
      expect(() => pointAdd(invalidPoint, validPoint)).toThrow(InvalidPublicKey);
      expect(() => pointAdd(validPoint, invalidPoint)).toThrow(InvalidPublicKey);
    });

    it('should validate points before operations', () => {
      const validScalar = new Uint8Array(32);
      validScalar[0] = 1;

      // Invalid point (all 0xff unlikely to be on curve)
      const invalidPoint = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        invalidPoint[i] = 0xff;
      }

      expect(() => scalarMult(validScalar, invalidPoint)).toThrow(InvalidPublicKey);
      expect(() => pointAdd(invalidPoint, invalidPoint)).toThrow(InvalidPublicKey);
    });
  });
});