import { ed25519 } from '@noble/curves/ed25519';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';

/**
 * Curve order L for ed25519
 */
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Add two ed25519 points.
 * @param p1 First point (32-byte compressed)
 * @param p2 Second point (32-byte compressed)
 * @returns Result point (32-byte compressed)
 */
export function pointAdd(p1: Uint8Array, p2: Uint8Array): Uint8Array {
  if (p1.length !== 32) throw new Error('Invalid p1 length');
  if (p2.length !== 32) throw new Error('Invalid p2 length');

  const point1 = ed25519.ExtendedPoint.fromHex(p1);
  const point2 = ed25519.ExtendedPoint.fromHex(p2);
  const result = point1.add(point2);

  return result.toRawBytes();
}

/**
 * Scalar multiplication with generator point.
 * @param scalar 32-byte scalar (little-endian)
 * @returns Result point (32-byte compressed)
 */
export function scalarMultBase(scalar: Uint8Array): Uint8Array {
  if (scalar.length !== 32) throw new Error('Invalid scalar length');

  const s = bytesToNumberLE(scalar);
  const result = ed25519.ExtendedPoint.BASE.multiply(s);

  return result.toRawBytes();
}

/**
 * Scalar multiplication with arbitrary point.
 * @param scalar 32-byte scalar (little-endian)
 * @param point 32-byte compressed point
 * @returns Result point (32-byte compressed)
 */
export function scalarMult(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  if (scalar.length !== 32) throw new Error('Invalid scalar length');
  if (point.length !== 32) throw new Error('Invalid point length');

  const s = bytesToNumberLE(scalar);
  const p = ed25519.ExtendedPoint.fromHex(point);
  const result = p.multiply(s);

  return result.toRawBytes();
}

/**
 * Add two scalars modulo curve order L.
 * @param s1 First scalar (32-byte, little-endian)
 * @param s2 Second scalar (32-byte, little-endian)
 * @returns Result scalar (32-byte, little-endian)
 */
export function scalarAdd(s1: Uint8Array, s2: Uint8Array): Uint8Array {
  if (s1.length !== 32) throw new Error('Invalid s1 length');
  if (s2.length !== 32) throw new Error('Invalid s2 length');

  const a = bytesToNumberLE(s1);
  const b = bytesToNumberLE(s2);
  const result = (a + b) % L;

  return numberToBytesLE(result, 32);
}