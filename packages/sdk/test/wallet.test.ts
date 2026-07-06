import { describe, it, expect } from 'vitest';
import { keysFromWalletSignature } from '../src/wallet.js';

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

// The same pinned signature vector locked in @stealth/crypto's derive-signature test.
const VECTOR_SIG_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const EXPECTED_SPEND_PUB =
  '3048c9a5cd80345a35e1a8fa05279d90ca355de5889b5c35163278a263a8330b';
const EXPECTED_VIEW_PUB =
  'ef3792561bf35026b50659e5aae53d9fe3786f2fae4f25bc1d02f5602c9ba2ed';

describe('keysFromWalletSignature', () => {
  it('derives the pinned vector public keys from a raw-bytes signer', async () => {
    const keys = await keysFromWalletSignature(
      async () => hexToBytes(VECTOR_SIG_HEX),
    );
    expect(keys.spendPubKey).toBe(EXPECTED_SPEND_PUB);
    expect(keys.viewPubKey).toBe(EXPECTED_VIEW_PUB);
  });

  it('accepts a hex-string signer result', async () => {
    const keys = await keysFromWalletSignature(async () => VECTOR_SIG_HEX);
    expect(keys.spendPubKey).toBe(EXPECTED_SPEND_PUB);
  });

  it('accepts a base64-string signer result', async () => {
    const b64 = Buffer.from(hexToBytes(VECTOR_SIG_HEX)).toString('base64');
    const keys = await keysFromWalletSignature(async () => b64);
    expect(keys.spendPubKey).toBe(EXPECTED_SPEND_PUB);
  });

  it("accepts Freighter's { signedMessage } envelope", async () => {
    const keys = await keysFromWalletSignature(async () => ({
      signedMessage: hexToBytes(VECTOR_SIG_HEX),
    }));
    expect(keys.viewPubKey).toBe(EXPECTED_VIEW_PUB);
  });

  it('throws when the signature is not 64 bytes', async () => {
    await expect(
      keysFromWalletSignature(async () => new Uint8Array(32)),
    ).rejects.toThrow();
  });

  it('does not silently mis-decode a 64-char-hex string as a 32-byte signature', async () => {
    // 64 hex chars = 32 bytes if read as hex. The old guard accepted any
    // even-length all-hex string and fell through to base64; the tightened
    // guard only treats 128-char hex as hex, so this input decodes as base64
    // (48 bytes) and must fail loudly rather than derive unrecoverable keys.
    const sixtyFourHex = '0123456789abcdef'.repeat(4);
    expect(sixtyFourHex).toHaveLength(64);
    await expect(
      keysFromWalletSignature(async () => sixtyFourHex),
    ).rejects.toThrow(/64 bytes/);
  });

  it('throws for a non-deterministic signer when verifyDeterminism is set', async () => {
    let call = 0;
    await expect(
      keysFromWalletSignature(
        async () => {
          call += 1;
          const sig = hexToBytes(VECTOR_SIG_HEX).slice();
          sig[0] = call; // different each call
          return sig;
        },
        { verifyDeterminism: true },
      ),
    ).rejects.toThrow(/non-deterministic/i);
  });

  it('returns a full StealthKeys shape with meta-address', async () => {
    const keys = await keysFromWalletSignature(
      async () => hexToBytes(VECTOR_SIG_HEX),
    );
    expect(keys.metaAddress.startsWith('st:stellar:')).toBe(true);
    expect(keys.spendPrivKey).toHaveLength(64);
    expect(keys.viewPrivKey).toHaveLength(64);
  });
});
