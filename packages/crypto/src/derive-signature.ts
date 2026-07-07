import type { StealthKeys } from './types.js';
import { scalarMultBase } from './ed25519.js';
import { hashToScalar } from './hash.js';
import { InvalidScalar } from './errors.js';

const textEncoder = new TextEncoder();

/**
 * Domain-separation context string identifying the v1 wallet-signature
 * key-derivation scheme. Embedded as the first line of the message a wallet
 * signs to derive stealth keys.
 */
export const KEY_DERIVATION_CONTEXT_V1 = 'stellar-shade-keys-v1';

/**
 * Build the canonical message a wallet signs to derive its stealth keys.
 *
 * The message is a deterministic, human-readable, newline-separated string.
 * Because RFC 8032 ed25519 signatures are deterministic, the same wallet
 * signing this exact message always yields the same signature, and therefore
 * the same stealth keys — that determinism is the whole point.
 *
 * This is a pure string builder with NO `@stellar/stellar-sdk` dependency, in
 * keeping with the crypto package's zero-SDK rule. Callers are responsible for
 * having the wallet sign the returned string.
 *
 * Security model:
 * - The `appId` scopes keys per application: different apps signing the same
 *   wallet produce independent stealth keys, so a leak in one app does not
 *   expose another.
 * - Users must NEVER sign this exact message for any other purpose. Signing it
 *   anywhere untrusted hands over the ability to derive (and thus control) the
 *   stealth keys. The WARNING line makes this explicit to the signer.
 *
 * @param opts - Optional scoping parameters.
 * @param opts.network - Network label to bind keys to (defaults to `'any'`).
 * @param opts.appId - Application identifier to scope keys (defaults to `'default'`).
 * @returns The exact newline-separated message to be signed.
 *
 * @example
 * ```typescript
 * const message = buildKeyDerivationMessage({ network: 'testnet', appId: 'my-app' });
 * const signature = await wallet.sign(message); // 64-byte ed25519 signature
 * const keys = deriveKeysFromSignature(signature);
 * ```
 */
export function buildKeyDerivationMessage(opts?: { network?: string; appId?: string }): string {
  const network = opts?.network ?? 'any';
  const appId = opts?.appId ?? 'default';

  return [
    KEY_DERIVATION_CONTEXT_V1,
    `network:${network}`,
    `app:${appId}`,
    'WARNING: Signing this message derives your stealth keys. Only sign it in apps you trust.',
  ].join('\n');
}

/**
 * Derive stealth spend and view keys from a wallet's ed25519 signature.
 *
 * Uses domain-separated SHA-256 hashing of the signature to derive two
 * independent ed25519 scalars for the spend and view key pairs, mirroring the
 * BIP-39 derivation in `hd.ts`.
 *
 * The input signature should be produced by having the wallet sign the message
 * from {@link buildKeyDerivationMessage}. RFC 8032 ed25519 signatures are
 * deterministic, so the same wallet signing the same message always re-derives
 * the same stealth keys — that reproducibility is the feature that lets a user
 * recover their stealth keys from just their wallet.
 *
 * Security model:
 * - Requires a DETERMINISTIC signer (RFC 8032 / RFC 6979 style). A wallet that
 *   randomises signatures would derive different keys on every call and break
 *   recovery. Do not use this with non-deterministic signers.
 * - Wallet compromise EQUALS stealth key compromise: anyone who can produce the
 *   signature can re-derive these keys. This is an accepted trade-off in
 *   exchange for keyless, recoverable-from-wallet stealth keys.
 * - Users must NEVER sign the derivation message for any other purpose; doing so
 *   exposes the derived keys. See the WARNING line in the signed message.
 * - Key scoping (network/appId) is handled upstream in the signed message, so
 *   distinct apps yield independent keys.
 *
 * @param signature - A 64-byte ed25519 signature over the derivation message.
 * @returns Stealth keys in the same shape returned by `generateMetaAddress`.
 * @throws {InvalidScalar} If the signature is not 64 bytes or is all zeros.
 *
 * @example
 * ```typescript
 * const message = buildKeyDerivationMessage({ appId: 'my-app' });
 * const signature = await wallet.sign(message);
 * const keys = deriveKeysFromSignature(signature);
 * // keys.metaAddress is the receiver's public meta-address
 * ```
 */
export function deriveKeysFromSignature(signature: Uint8Array): StealthKeys {
  if (signature.length !== 64) {
    throw new InvalidScalar('Signature must be 64 bytes');
  }
  if (signature.every((byte) => byte === 0)) {
    throw new InvalidScalar('Signature must not be all zeros');
  }

  const spendTag = textEncoder.encode('shade-spend');
  const viewTag = textEncoder.encode('shade-view');

  const spendInput = new Uint8Array(spendTag.length + signature.length);
  spendInput.set(spendTag, 0);
  spendInput.set(signature, spendTag.length);

  const viewInput = new Uint8Array(viewTag.length + signature.length);
  viewInput.set(viewTag, 0);
  viewInput.set(signature, viewTag.length);

  const spendPrivKey = hashToScalar(spendInput);
  const viewPrivKey = hashToScalar(viewInput);

  // Zero sensitive intermediates
  spendInput.fill(0);
  viewInput.fill(0);

  const spendPubKey = scalarMultBase(spendPrivKey);
  const viewPubKey = scalarMultBase(viewPrivKey);

  return {
    spendPrivKey,
    viewPrivKey,
    metaAddress: { spendPubKey, viewPubKey },
  };
}
