import { ed25519 } from '@noble/curves/ed25519';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/abstract/utils';
import { PointAtInfinity, InvalidPublicKey, InvalidScalar } from './errors.js';

/**
 * Curve order L for ed25519
 */
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Validate that a point is on the ed25519 curve.
 * @param point 32-byte compressed point
 * @returns true if valid
 * @throws InvalidPublicKey if not on curve
 */
export function validatePoint(point: Uint8Array): boolean {
  if (point.length !== 32) {
    throw new InvalidPublicKey('Invalid point length');
  }

  try {
    // This will throw if point is not on curve
    ed25519.ExtendedPoint.fromHex(point);
    return true;
  } catch (e) {
    if (e instanceof InvalidPublicKey) throw e;
    throw new InvalidPublicKey('Point not on curve');
  }
}

/**
 * Add two ed25519 points.
 * @param p1 First point (32-byte compressed)
 * @param p2 Second point (32-byte compressed)
 * @returns Result point (32-byte compressed)
 * @throws PointAtInfinity if result is point at infinity
 * @throws InvalidPublicKey if points are not on curve
 */
export function pointAdd(p1: Uint8Array, p2: Uint8Array): Uint8Array {
  if (p1.length !== 32) throw new InvalidPublicKey('Invalid p1 length');
  if (p2.length !== 32) throw new InvalidPublicKey('Invalid p2 length');

  // Validate both points are on curve
  validatePoint(p1);
  validatePoint(p2);

  const point1 = ed25519.ExtendedPoint.fromHex(p1);
  const point2 = ed25519.ExtendedPoint.fromHex(p2);
  const result = point1.add(point2);

  // Check for point at infinity
  if (result.equals(ed25519.ExtendedPoint.ZERO)) {
    throw new PointAtInfinity('pointAdd');
  }

  return result.toRawBytes();
}

/**
 * Scalar multiplication with generator point.
 * @param scalar 32-byte scalar (little-endian)
 * @param allowZero Allow zero scalar (returns point at infinity)
 * @returns Result point (32-byte compressed)
 * @throws InvalidScalar if scalar is zero and not allowed
 */
export function scalarMultBase(scalar: Uint8Array, allowZero = false): Uint8Array {
  if (scalar.length !== 32) throw new InvalidScalar('Invalid scalar length');

  // Reduce scalar modulo L
  const s = bytesToNumberLE(scalar) % L;

  // Handle zero scalar case
  if (s === 0n) {
    if (!allowZero) {
      throw new InvalidScalar('Zero scalar not allowed');
    }
    return ed25519.ExtendedPoint.ZERO.toRawBytes();
  }

  const result = ed25519.ExtendedPoint.BASE.multiply(s);

  return result.toRawBytes();
}

/**
 * Scalar multiplication with arbitrary point.
 * @param scalar 32-byte scalar (little-endian)
 * @param point 32-byte compressed point
 * @param allowZero Allow zero scalar (returns point at infinity)
 * @returns Result point (32-byte compressed)
 * @throws InvalidScalar if scalar is zero and not allowed
 * @throws InvalidPublicKey if point is not on curve
 * @throws PointAtInfinity if result is point at infinity
 */
export function scalarMult(scalar: Uint8Array, point: Uint8Array, allowZero = false): Uint8Array {
  if (scalar.length !== 32) throw new InvalidScalar('Invalid scalar length');
  if (point.length !== 32) throw new InvalidPublicKey('Invalid point length');

  // Validate point is on curve
  validatePoint(point);

  // Reduce scalar modulo L
  const s = bytesToNumberLE(scalar) % L;

  // Handle zero scalar case
  if (s === 0n) {
    if (!allowZero) {
      throw new InvalidScalar('Zero scalar not allowed');
    }
    return ed25519.ExtendedPoint.ZERO.toRawBytes();
  }

  const p = ed25519.ExtendedPoint.fromHex(point);
  const result = p.multiply(s);

  // Check for point at infinity (should not happen with valid inputs)
  if (result.equals(ed25519.ExtendedPoint.ZERO)) {
    throw new PointAtInfinity('scalarMult');
  }

  return result.toRawBytes();
}

/**
 * Add two scalars modulo curve order L.
 * @param s1 First scalar (32-byte, little-endian)
 * @param s2 Second scalar (32-byte, little-endian)
 * @returns Result scalar (32-byte, little-endian)
 * @throws InvalidScalar if inputs have wrong length
 */
export function scalarAdd(s1: Uint8Array, s2: Uint8Array): Uint8Array {
  if (s1.length !== 32) throw new InvalidScalar('Invalid s1 length');
  if (s2.length !== 32) throw new InvalidScalar('Invalid s2 length');

  const a = bytesToNumberLE(s1) % L;
  const b = bytesToNumberLE(s2) % L;
  const result = (a + b) % L;

  return numberToBytesLE(result, 32);
}