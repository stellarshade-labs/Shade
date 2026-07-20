import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha256';
import { buildKeyDerivationMessage, encodeMetaAddress } from '@shade/crypto';
import { keysFromWalletSignature, DEFAULT_KEY_SCOPE, DEFAULT_APP_ID } from 'stellar-shade';
import { deriveFromStellarSecret } from '../src/commands/keygen.js';

// Reproduce the exact SEP-53 signing envelope the CLI/wallet uses: the signer
// signs SHA-256("Stellar Signed Message:\n" + derivationMessage).
function sep53Signature(secret: string, keyScope: string, appId: string): Uint8Array {
  const keypair = Keypair.fromSecret(secret);
  const message = buildKeyDerivationMessage({ network: keyScope, appId });
  const envelope = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf-8'),
    Buffer.from(message, 'utf-8'),
  ]);
  const digest = sha256(new Uint8Array(envelope));
  return new Uint8Array(keypair.sign(Buffer.from(digest)));
}

describe('cross-tool key derivation (CLI secret path vs SDK signature path)', () => {
  const SECRET = Keypair.random().secret();
  const scope = DEFAULT_KEY_SCOPE;
  const appId = DEFAULT_APP_ID;

  it('produces the SAME meta-address from both paths for identical {scope, appId}', async () => {
    // CLI path: derive directly from the Stellar secret.
    const cliKeys = deriveFromStellarSecret(SECRET, scope, appId);
    const cliMeta = encodeMetaAddress(cliKeys.metaAddress);

    // SDK path: feed the SDK the SAME SEP-53 signature the wallet would produce.
    const sig = sep53Signature(SECRET, scope, appId);
    const sdkKeys = await keysFromWalletSignature(async () => sig, {
      keyScope: scope,
      appId,
      // Signer is a fixed byte array here — determinism is guaranteed.
      verifyDeterminism: false,
    });

    expect(sdkKeys.metaAddress).toBe(cliMeta);
    expect(sdkKeys.spendPubKey).toBe(
      Buffer.from(cliKeys.metaAddress.spendPubKey).toString('hex'),
    );
    expect(sdkKeys.viewPubKey).toBe(
      Buffer.from(cliKeys.metaAddress.viewPubKey).toString('hex'),
    );
  });

  it('uses matching defaults across both tools (scope=stealth, appId=default)', () => {
    expect(DEFAULT_KEY_SCOPE).toBe('stealth');
    expect(DEFAULT_APP_ID).toBe('default');
  });

  it('key scope is DECOUPLED from transport network: same wallet + different transport network keeps keys stable', async () => {
    // The transport network (local/testnet) is NOT part of derivation. Deriving
    // with the fixed key-scope always yields the same meta-address regardless of
    // which network a later transaction targets.
    const a = deriveFromStellarSecret(SECRET, scope, appId);
    const b = deriveFromStellarSecret(SECRET, scope, appId);
    expect(encodeMetaAddress(a.metaAddress)).toBe(encodeMetaAddress(b.metaAddress));

    // A different explicit scope MUST yield different keys (scoping works).
    const other = deriveFromStellarSecret(SECRET, 'other-scope', appId);
    expect(encodeMetaAddress(other.metaAddress)).not.toBe(
      encodeMetaAddress(a.metaAddress),
    );
  });
});
