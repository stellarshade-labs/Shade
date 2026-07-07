import { generateMnemonic as _generateMnemonic, validateMnemonic as _validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { StealthKeys } from './types.js';
import { scalarMultBase } from './ed25519.js';
import { hashToScalar } from './hash.js';

const textEncoder = new TextEncoder();

/**
 * Generate a 12-word BIP-39 mnemonic phrase.
 */
export function generateMnemonic(): string {
  return _generateMnemonic(wordlist);
}

/**
 * Validate a mnemonic phrase against the BIP-39 english wordlist.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive stealth spend and view keys from a BIP-39 mnemonic.
 *
 * Uses domain-separated SHA-256 hashing of the BIP-39 seed to derive
 * two independent ed25519 scalars for the spend and view key pairs.
 */
export function mnemonicToStealthKeys(mnemonic: string, passphrase?: string): StealthKeys {
  if (!_validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const seed = mnemonicToSeedSync(mnemonic, passphrase || '');

  const spendTag = textEncoder.encode('shade-spend');
  const viewTag = textEncoder.encode('shade-view');

  const spendInput = new Uint8Array(spendTag.length + seed.length);
  spendInput.set(spendTag, 0);
  spendInput.set(seed, spendTag.length);

  const viewInput = new Uint8Array(viewTag.length + seed.length);
  viewInput.set(viewTag, 0);
  viewInput.set(seed, viewTag.length);

  const spendPrivKey = hashToScalar(spendInput);
  const viewPrivKey = hashToScalar(viewInput);

  // Zero sensitive intermediates
  seed.fill(0);
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
