/**
 * Custom error types for crypto operations
 */

/**
 * Error thrown when a point operation results in the point at infinity
 */
export class PointAtInfinity extends Error {
  constructor(operation: string) {
    super(`Point at infinity encountered in ${operation}`);
    this.name = 'PointAtInfinity';
  }
}

/**
 * Error thrown when a public key is not on the ed25519 curve
 */
export class InvalidPublicKey extends Error {
  constructor(message = 'Invalid public key: not on curve') {
    super(message);
    this.name = 'InvalidPublicKey';
  }
}

/**
 * Error thrown when a scalar value is invalid (e.g., zero where not allowed)
 */
export class InvalidScalar extends Error {
  constructor(message = 'Invalid scalar value') {
    super(message);
    this.name = 'InvalidScalar';
  }
}

/**
 * Error thrown when meta-address encoding/decoding fails
 */
export class InvalidMetaAddress extends Error {
  constructor(message = 'Invalid meta-address format') {
    super(message);
    this.name = 'InvalidMetaAddress';
  }
}