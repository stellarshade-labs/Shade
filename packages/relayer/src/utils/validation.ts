import { StrKey } from '@stellar/stellar-sdk';

export function validateStellarAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return StrKey.isValidEd25519PublicKey(address);
}
