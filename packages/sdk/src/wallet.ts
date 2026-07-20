import {
  buildKeyDerivationMessage,
  deriveKeysFromSignature,
  encodeMetaAddress,
} from '@shade/crypto';
// Deliberately the SDK's own mirror, not '@shade/crypto' — this type appears in
// an exported signature, and crypto's version cannot be inlined into the
// published .d.ts. ./raw-keys.ts proves the two stay structurally identical.
import type { RawStealthKeys } from './raw-keys.js';
import type { StealthKeys } from './types.js';

/**
 * Convert crypto's raw stealth keys (Uint8Array scalars + meta-address object,
 * as returned by `generateMetaAddress`, `mnemonicToStealthKeys`, or
 * `deriveKeysFromSignature`) into the SDK's hex-string {@link StealthKeys}
 * shape used by every client/session API.
 *
 * The two packages deliberately reuse the name `StealthKeys` for different
 * shapes; import the raw one as `RawStealthKeys` (re-exported from the SDK
 * index) and convert at the boundary with this helper.
 */
export function stealthKeysFromRaw(raw: RawStealthKeys): StealthKeys {
  return {
    metaAddress: encodeMetaAddress(raw.metaAddress),
    spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
  };
}

/**
 * A wallet signer. Given the derivation message it returns an ed25519 signature
 * in one of the shapes real wallets produce: raw bytes, a hex/base64 string, or
 * Freighter's `{ signedMessage }` envelope.
 */
export type WalletSigner = (
  message: string,
) => Promise<
  Uint8Array | string | { signedMessage: string | Uint8Array }
>;

/**
 * The default key-derivation scope. This is DECOUPLED from any transport network
 * (e.g. testnet vs. local) so that a wallet re-derives the same stealth keys
 * regardless of which network a transaction is later submitted to. The CLI's
 * `--key-scope` flag defaults to this exact value so both tools line up.
 */
export const DEFAULT_KEY_SCOPE = 'stealth';

/** The default application id used to scope derived keys. */
export const DEFAULT_APP_ID = 'default';

/** Options for {@link keysFromWalletSignature}. */
export interface WalletKeysOpts {
  /**
   * Key-derivation scope folded into the signed message (crypto's `network`
   * field). This MUST be decoupled from the transport network: use the same
   * value everywhere you derive from this wallet, or you will get different
   * (unrecoverable) keys. Defaults to {@link DEFAULT_KEY_SCOPE} (`'stealth'`),
   * matching the CLI's `--key-scope` default so both tools derive identical keys.
   */
  keyScope?: string;
  /**
   * Application id to scope keys (folded into the signed message). Defaults to
   * {@link DEFAULT_APP_ID} (`'default'`), matching the CLI's `--app-id` default.
   */
  appId?: string;
  /**
   * Sign the message TWICE and throw when the two signatures differ. This guards
   * against randomized/hardware signers that would otherwise derive different
   * (unrecoverable) keys on every call. Defaults to `true`; pass `false` only
   * for a signer you KNOW is deterministic (RFC 8032) to skip the extra signature.
   */
  verifyDeterminism?: boolean;
}

function decodeToBytes(raw: string): Uint8Array {
  // Treat the input as hex ONLY when it is exactly 128 hex chars (a 64-byte
  // ed25519 signature). This avoids the ambiguity where a base64 payload that
  // happens to be all-hex-and-even-length would be silently mis-decoded as hex.
  const isSignatureHex = raw.length === 128 && /^[0-9a-fA-F]+$/.test(raw);
  const bytes = isSignatureHex
    ? new Uint8Array(Buffer.from(raw, 'hex'))
    : new Uint8Array(Buffer.from(raw, 'base64'));

  if (bytes.length !== 64) {
    throw new Error(
      `Wallet signature must decode to exactly 64 bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function normalizeSignature(
  result: Uint8Array | string | { signedMessage: string | Uint8Array },
): Uint8Array {
  let bytes: Uint8Array;
  if (result instanceof Uint8Array) {
    bytes = result;
  } else if (typeof result === 'string') {
    bytes = decodeToBytes(result);
  } else if (result && typeof result === 'object' && 'signedMessage' in result) {
    const inner = result.signedMessage;
    bytes = inner instanceof Uint8Array ? inner : decodeToBytes(inner);
  } else {
    throw new Error('Unsupported signer result shape');
  }

  if (bytes.length !== 64) {
    throw new Error(
      `Wallet signature must be exactly 64 bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Derive stealth keys from a wallet's signature over the canonical derivation
 * message.
 *
 * Because RFC 8032 ed25519 signatures are deterministic, the same wallet
 * signing the same message always re-derives the same stealth keys — that is
 * what lets a user recover stealth keys from their wallet alone, with no extra
 * secret to store. Wallet compromise equals stealth-key compromise; this is the
 * accepted trade-off for keyless recovery.
 *
 * @param signer - Callback that signs the derivation message (see {@link WalletSigner}).
 * @param opts - Optional keyScope/appId scoping and determinism verification.
 *   `keyScope` and `appId` MUST match across every tool that derives from this
 *   wallet (they default to `'stealth'` / `'default'`, the same as the CLI).
 * @returns Hex-string {@link StealthKeys} in the same shape as `keygen()`.
 * @throws If the signature is not exactly 64 bytes, or (unless
 *   `verifyDeterminism: false`) if two signatures over the same message differ.
 *
 * @example
 * ```typescript
 * // verifyDeterminism defaults to true; pass false only for a known-good signer.
 * const keys = await keysFromWalletSignature(
 *   (msg) => freighter.signMessage(msg),
 *   { appId: 'my-app' },
 * );
 * ```
 */
export async function keysFromWalletSignature(
  signer: WalletSigner,
  opts?: WalletKeysOpts,
): Promise<StealthKeys> {
  const message = buildKeyDerivationMessage({
    network: opts?.keyScope ?? DEFAULT_KEY_SCOPE,
    appId: opts?.appId ?? DEFAULT_APP_ID,
  });

  const signature = normalizeSignature(await signer(message));

  if (opts?.verifyDeterminism !== false) {
    const second = normalizeSignature(await signer(message));
    if (!equalBytes(signature, second)) {
      throw new Error(
        'Signer is non-deterministic: two signatures over the same message differ. ' +
          'Wallet-derived stealth keys require a deterministic (RFC 8032) signer.',
      );
    }
  }

  return stealthKeysFromRaw(deriveKeysFromSignature(signature));
}
