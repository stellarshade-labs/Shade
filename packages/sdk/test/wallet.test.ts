import { describe, it, expect } from 'vitest';
import { keysFromWalletSignature } from '../src/wallet.js';

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

// The same pinned signature vector locked in @shade/crypto's derive-signature test.
const VECTOR_SIG_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const EXPECTED_SPEND_PUB =
  '07c0ae61f878ac7a057128287b2a48f5cd55d18e52da4bbe94f66c7f7b61071e';
const EXPECTED_VIEW_PUB =
  '304ba3fc98cb71ac755ac3e3abfa7dad04dcae9754f7cdc3f19b53642fcf5ce6';

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

  it('throws for a non-deterministic signer BY DEFAULT (verifyDeterminism defaults to true)', async () => {
    let call = 0;
    await expect(
      // No opts: determinism check must run by default and catch the mismatch.
      keysFromWalletSignature(async () => {
        call += 1;
        const sig = hexToBytes(VECTOR_SIG_HEX).slice();
        sig[0] = call; // different each call
        return sig;
      }),
    ).rejects.toThrow(/non-deterministic/i);
  });

  it('still throws for a non-deterministic signer when verifyDeterminism is explicitly true', async () => {
    let call = 0;
    await expect(
      keysFromWalletSignature(
        async () => {
          call += 1;
          const sig = hexToBytes(VECTOR_SIG_HEX).slice();
          sig[0] = call;
          return sig;
        },
        { verifyDeterminism: true },
      ),
    ).rejects.toThrow(/non-deterministic/i);
  });

  it('skips the determinism check (signs once) when verifyDeterminism is false', async () => {
    let calls = 0;
    const keys = await keysFromWalletSignature(
      async () => {
        calls += 1;
        // Return a DIFFERENT signature each call; because the check is skipped,
        // the first signature is used and no throw occurs.
        const sig = hexToBytes(VECTOR_SIG_HEX).slice();
        sig[0] = calls;
        return sig;
      },
      { verifyDeterminism: false },
    );
    expect(calls).toBe(1);
    expect(keys.metaAddress.startsWith('shade:stellar:')).toBe(true);
  });

  it('signs the message TWICE by default for a deterministic signer', async () => {
    let calls = 0;
    await keysFromWalletSignature(async () => {
      calls += 1;
      return hexToBytes(VECTOR_SIG_HEX);
    });
    expect(calls).toBe(2);
  });

  it('returns a full StealthKeys shape with meta-address', async () => {
    const keys = await keysFromWalletSignature(
      async () => hexToBytes(VECTOR_SIG_HEX),
    );
    expect(keys.metaAddress.startsWith('shade:stellar:')).toBe(true);
    expect(keys.spendPrivKey).toHaveLength(64);
    expect(keys.viewPrivKey).toHaveLength(64);
  });
});
