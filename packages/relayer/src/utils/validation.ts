import { StrKey } from '@stellar/stellar-sdk';

export function validateStellarAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return StrKey.isValidEd25519PublicKey(address);
}

export function validateAmount(amount: string | number): number | null {
  const xlmAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

  if (isNaN(xlmAmount) || xlmAmount < 1) {
    return null;
  }

  if (xlmAmount > 1000000) {
    return null;
  }

  return xlmAmount;
}

export function validateTransaction(txEnvelope: string): boolean {
  if (!txEnvelope || typeof txEnvelope !== 'string') {
    return false;
  }

  if (txEnvelope.length < 100 || txEnvelope.length > 100000) {
    return false;
  }

  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return base64Regex.test(txEnvelope);
}