import {
  buildKeyDerivationMessage,
  deriveKeysFromSignature,
  encodeMetaAddress,
} from '@stealth/crypto';
import type { StealthKeys } from './types.js';

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

/** Options for {@link keysFromWalletSignature}. */
export interface WalletKeysOpts {
  /** Network label to scope keys (folded into the signed message). */
  network?: string;
  /** Application id to scope keys (folded into the signed message). */
  appId?: string;
  /**
   * If true, sign the message TWICE and throw when the two signatures differ.
   * This guards against randomized/hardware signers that would otherwise derive
   * different (unrecoverable) keys on every call.
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
 * @param opts - Optional network/appId scoping and determinism verification.
 * @returns Hex-string {@link StealthKeys} in the same shape as `keygen()`.
 * @throws If the signature is not exactly 64 bytes, or (with
 *   `verifyDeterminism`) if two signatures over the same message differ.
 *
 * @example
 * ```typescript
 * const keys = await keysFromWalletSignature(
 *   (msg) => freighter.signMessage(msg),
 *   { appId: 'my-app', verifyDeterminism: true },
 * );
 * ```
 */
export async function keysFromWalletSignature(
  signer: WalletSigner,
  opts?: WalletKeysOpts,
): Promise<StealthKeys> {
  const message = buildKeyDerivationMessage({
    network: opts?.network,
    appId: opts?.appId,
  });

  const signature = normalizeSignature(await signer(message));

  if (opts?.verifyDeterminism) {
    const second = normalizeSignature(await signer(message));
    if (!equalBytes(signature, second)) {
      throw new Error(
        'Signer is non-deterministic: two signatures over the same message differ. ' +
          'Wallet-derived stealth keys require a deterministic (RFC 8032) signer.',
      );
    }
  }

  const keys = deriveKeysFromSignature(signature);
  const metaAddress = encodeMetaAddress(keys.metaAddress);

  return {
    metaAddress,
    spendPubKey: Buffer.from(keys.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(keys.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(keys.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(keys.viewPrivKey).toString('hex'),
  };
}
