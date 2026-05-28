/**
 * Stellar StrKey encoding (base32check) for ed25519 public keys.
 * This module provides pure TypeScript implementation without @stellar/stellar-sdk dependency.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VERSION_BYTE_PUBLIC_KEY = 6 << 3; // G addresses

/**
 * CRC16-XModem checksum implementation.
 */
function crc16XModem(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  return crc & 0xffff;
}

/**
 * Base32 encode (RFC 4648) without padding.
 */
function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i]!;
    bits += 8;

    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Base32 decode (RFC 4648).
 */
function base32Decode(str: string): Uint8Array {
  const output: number[] = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < str.length; i++) {
    const idx = ALPHABET.indexOf(str[i]!);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${str[i]}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    while (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

/**
 * Encode ed25519 public key to Stellar address format (G...).
 * @param pubKey 32-byte ed25519 public key
 * @returns Stellar address in StrKey format (G...)
 */
export function encodePublicKey(pubKey: Uint8Array): string {
  if (pubKey.length !== 32) {
    throw new Error('Public key must be 32 bytes');
  }

  const versionedPayload = new Uint8Array(33);
  versionedPayload[0] = VERSION_BYTE_PUBLIC_KEY;
  versionedPayload.set(pubKey, 1);

  const checksum = crc16XModem(versionedPayload);
  const checksumBytes = new Uint8Array(2);
  checksumBytes[0] = checksum & 0xff;
  checksumBytes[1] = (checksum >>> 8) & 0xff;

  const fullPayload = new Uint8Array(35);
  fullPayload.set(versionedPayload, 0);
  fullPayload.set(checksumBytes, 33);

  return base32Encode(fullPayload);
}

/**
 * Decode Stellar address to ed25519 public key.
 * @param address Stellar address in StrKey format (G...)
 * @returns 32-byte ed25519 public key
 */
export function decodePublicKey(address: string): Uint8Array {
  if (!address.startsWith('G')) {
    throw new Error('Invalid Stellar address: must start with G');
  }

  const decoded = base32Decode(address);
  if (decoded.length !== 35) {
    throw new Error('Invalid Stellar address: incorrect length');
  }

  const versionByte = decoded[0]!;
  if (versionByte !== VERSION_BYTE_PUBLIC_KEY) {
    throw new Error('Invalid Stellar address: wrong version byte');
  }

  const versionedPayload = decoded.slice(0, 33);
  const providedChecksum = (decoded[34]! << 8) | decoded[33]!;
  const calculatedChecksum = crc16XModem(versionedPayload);

  if (providedChecksum !== calculatedChecksum) {
    throw new Error('Invalid Stellar address: checksum mismatch');
  }

  return decoded.slice(1, 33);
}