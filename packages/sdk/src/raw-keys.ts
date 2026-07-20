import type {
  StealthKeys as CryptoStealthKeys,
  StealthMetaAddress as CryptoStealthMetaAddress,
} from '@shade/crypto';

/**
 * Crypto's raw (`Uint8Array`-based) meta-address, mirrored here.
 *
 * The SDK's own {@link StealthMetaAddress} is a `shade:stellar:` *string*; this
 * is the byte-level pair the crypto layer works with.
 */
export interface RawStealthMetaAddress {
  /** 32-byte ed25519 public key for spending */
  spendPubKey: Uint8Array;
  /** 32-byte ed25519 public key for viewing */
  viewPubKey: Uint8Array;
}

/**
 * Crypto's raw (`Uint8Array`-based) stealth keys, exposed under a distinct name
 * so code that mixes both layers has one import site: convert with
 * {@link stealthKeysFromRaw} to get the SDK's hex-string {@link StealthKeys}.
 */
export interface RawStealthKeys {
  /** 32-byte ed25519 private key for spending */
  spendPrivKey: Uint8Array;
  /** 32-byte ed25519 private key for viewing */
  viewPrivKey: Uint8Array;
  /** Derived meta-address containing public keys */
  metaAddress: RawStealthMetaAddress;
}

// These are declared structurally rather than re-exported from '@shade/crypto'
// on purpose. @shade/crypto is bundled into the published artifact and never
// published itself, and the declaration bundler cannot inline a type that
// crypto's barrel re-exports from a deeper module — it emits a dangling
// `from './types.js'` that consumers cannot resolve.
//
// The cost of mirroring is drift, so the two assignments below make the
// compiler enforce that these stay structurally identical to crypto's. If
// either shape changes, `npm run typecheck` fails here rather than shipping a
// silently wrong public type.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _metaAddressMatchesCrypto: MutuallyAssignable<
  RawStealthMetaAddress,
  CryptoStealthMetaAddress
> = true;
const _keysMatchCrypto: MutuallyAssignable<RawStealthKeys, CryptoStealthKeys> = true;

void _metaAddressMatchesCrypto;
void _keysMatchCrypto;
