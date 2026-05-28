// Types
export type {
  StealthKeys,
  StealthMetaAddress,
  StealthAddress,
  Announcement,
} from './types.js';

// Errors
export {
  InvalidPublicKey,
  InvalidScalar,
  InvalidMetaAddress,
  PointAtInfinity,
} from './errors.js';

// Core stealth address functions
export {
  generateMetaAddress,
  encodeMetaAddress,
  decodeMetaAddress,
} from './keys.js';

export {
  deriveStealthAddress,
  computeStealthAddress,
  type StealthDerivation,
} from './stealth.js';

export {
  scanAnnouncements,
  checkViewTag,
  isMyStealthAddress,
} from './scan.js';

export {
  recoverStealthPrivateKey,
} from './recover.js';

// Stellar key conversion
export {
  encodePublicKey,
  decodePublicKey,
} from './stellar-keys.js';

// Ownership proof and raw-scalar signing
export {
  signWithStealthKey,
  proveOwnership,
  verifyOwnership,
} from './prove.js';

// Advanced features
export {
  encryptAmount,
  decryptAmount,
  deriveStealthAddressWithSecret,
  type StealthDerivationWithSecret,
} from './advanced.js';

// Low-level cryptographic primitives (for advanced users)
export {
  L, // Curve order
  validatePoint,
  pointAdd,
  scalarMultBase,
  scalarMult,
  scalarAdd,
} from './ed25519.js';

export {
  hashToScalar,
  viewTag,
} from './hash.js';