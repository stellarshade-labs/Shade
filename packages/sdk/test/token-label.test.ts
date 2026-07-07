import { describe, it, expect } from 'vitest';
import { Asset, Networks } from '@stellar/stellar-sdk';
import { labelForToken } from '../src/soroban.js';

describe('labelForToken', () => {
  const passphrase = Networks.STANDALONE;

  it("maps the native SAC contract address to 'XLM'", () => {
    const nativeSac = Asset.native().contractId(passphrase);
    expect(labelForToken(nativeSac, passphrase)).toBe('XLM');
  });

  it("maps the literal 'native' and 'XLM' to 'XLM'", () => {
    expect(labelForToken('native', passphrase)).toBe('XLM');
    expect(labelForToken('XLM', passphrase)).toBe('XLM');
  });

  it('returns a non-native SAC C-address unchanged', () => {
    const usdcSac = new Asset(
      'USDC',
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    ).contractId(passphrase);
    expect(labelForToken(usdcSac, passphrase)).toBe(usdcSac);
  });

  it("passes through 'unknown' and empty tokens", () => {
    expect(labelForToken('unknown', passphrase)).toBe('unknown');
    expect(labelForToken('', passphrase)).toBe('');
  });

  it('does not treat the native SAC of one network as native on another', () => {
    const localNative = Asset.native().contractId(Networks.STANDALONE);
    // On testnet the native SAC id differs, so the local id is not recognized.
    expect(labelForToken(localNative, Networks.TESTNET)).toBe(localNative);
  });
});
