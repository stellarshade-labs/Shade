import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';
import {
  pointAdd,
  scalarMultBase,
  scalarMult,
  scalarAdd,
  L,
} from '../src/ed25519.js';

describe('ed25519 primitives', () => {
  it('should compute scalar multiplication with base point', () => {
    // Test with known scalar (1)
    const one = new Uint8Array(32);
    one[0] = 1;
    const result = scalarMultBase(one);
    const expected = ed25519.ExtendedPoint.BASE.toRawBytes();
    expect(bytesToHex(result)).toBe(bytesToHex(expected));
  });

  it('should add two points correctly', () => {
    // G + G = 2*G
    const G = ed25519.ExtendedPoint.BASE.toRawBytes();
    const twoG = ed25519.ExtendedPoint.BASE.double().toRawBytes();
    const result = pointAdd(G, G);
    expect(bytesToHex(result)).toBe(bytesToHex(twoG));
  });

  it('should perform scalar multiplication with arbitrary point', () => {
    // Test 2 * G = 2G
    const two = new Uint8Array(32);
    two[0] = 2;
    const G = ed25519.ExtendedPoint.BASE.toRawBytes();
    const result = scalarMult(two, G);
    const expected = ed25519.ExtendedPoint.BASE.double().toRawBytes();
    expect(bytesToHex(result)).toBe(bytesToHex(expected));
  });

  it('should add scalars modulo L correctly', () => {
    // Test (L-1) + 2 = 1 (mod L)
    const lMinus1 = new Uint8Array(32);
    // L-1 in little-endian
    const lMinus1Hex = 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f';
    const lMinus1Bytes = hexToBytes(lMinus1Hex);

    const two = new Uint8Array(32);
    two[0] = 2;

    const result = scalarAdd(lMinus1Bytes, two);
    const expected = new Uint8Array(32);
    expected[0] = 1;

    expect(bytesToHex(result)).toBe(bytesToHex(expected));
  });

  it('should handle identity element correctly', () => {
    // 0 * G = O (point at infinity, represented as identity)
    const zero = new Uint8Array(32);
    const result = scalarMultBase(zero);
    const identity = ed25519.ExtendedPoint.ZERO.toRawBytes();
    expect(bytesToHex(result)).toBe(bytesToHex(identity));
  });

  it('should validate curve order L', () => {
    // Verify L is correct
    const expectedL = 2n ** 252n + 27742317777372353535851937790883648493n;
    expect(L).toBe(expectedL);
  });

  it('should reject invalid length inputs', () => {
    const invalidScalar = new Uint8Array(31); // Wrong length
    const validPoint = new Uint8Array(32);

    expect(() => scalarMultBase(invalidScalar)).toThrow('Invalid scalar length');
    expect(() => scalarMult(invalidScalar, validPoint)).toThrow('Invalid scalar length');
    expect(() => scalarMult(validPoint, invalidScalar)).toThrow('Invalid point length');
    expect(() => pointAdd(invalidScalar, validPoint)).toThrow('Invalid p1 length');
    expect(() => pointAdd(validPoint, invalidScalar)).toThrow('Invalid p2 length');
    expect(() => scalarAdd(invalidScalar, validPoint)).toThrow('Invalid s1 length');
    expect(() => scalarAdd(validPoint, invalidScalar)).toThrow('Invalid s2 length');
  });
});