import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { buildWithdrawMessage } from '../src/soroban.js';

// Fixed inputs used to pin the domain-separated preimage layout:
//   stealth_pk[32] || token_strkey_ascii[56] || amount_be_i128[16]
//   || dest_strkey_ascii[56] || nonce_be_u64[8]
//   || contract_strkey_ascii[56] || network_id[32]
const STEALTH_PK = new Uint8Array(32).fill(1);
const TOKEN = 'C' + 'A'.repeat(55);
const DEST = 'G' + 'B'.repeat(55);
const CONTRACT = 'C' + 'D'.repeat(55);
const PASSPHRASE = 'Test SDF Network ; September 2015';
const AMOUNT = 1234567n;
const NONCE = 7n;

// Vector computed once with the NEW field order (see reference impl below).
const EXPECTED_HASH =
  '77e0610aec24add83679adc6dae8ef64efacf2ac716f10ab0078951edf25c145';

function i128BE(v: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const d = new DataView(b.buffer);
  d.setBigInt64(0, v >> 64n);
  d.setBigUint64(8, v & 0xFFFFFFFFFFFFFFFFn);
  return b;
}

function u64BE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  const d = new DataView(b.buffer);
  d.setBigUint64(0, v);
  return b;
}

function referencePreimage(): Uint8Array {
  const tokenB = Buffer.from(TOKEN, 'utf-8');
  const destB = Buffer.from(DEST, 'utf-8');
  const contractB = Buffer.from(CONTRACT, 'utf-8');
  const netId = sha256(Buffer.from(PASSPHRASE, 'utf-8'));
  const msg = new Uint8Array(32 + 56 + 16 + 56 + 8 + 56 + 32);
  let o = 0;
  msg.set(STEALTH_PK, o); o += 32;
  msg.set(tokenB, o); o += 56;
  msg.set(i128BE(AMOUNT), o); o += 16;
  msg.set(destB, o); o += 56;
  msg.set(u64BE(NONCE), o); o += 8;
  msg.set(contractB, o); o += 56;
  msg.set(netId, o);
  return msg;
}

describe('buildWithdrawMessage domain-separated preimage', () => {
  it('preimage is exactly 256 bytes (32+56+16+56+8+56+32)', () => {
    expect(referencePreimage().length).toBe(256);
  });

  it('matches the pinned SHA-256 vector for the new layout', () => {
    const hash = buildWithdrawMessage(
      STEALTH_PK,
      TOKEN,
      AMOUNT,
      DEST,
      NONCE,
      CONTRACT,
      PASSPHRASE,
    );
    expect(Buffer.from(hash).toString('hex')).toBe(EXPECTED_HASH);
  });

  it('equals SHA-256 of the independently constructed preimage', () => {
    const hash = buildWithdrawMessage(
      STEALTH_PK,
      TOKEN,
      AMOUNT,
      DEST,
      NONCE,
      CONTRACT,
      PASSPHRASE,
    );
    expect(Buffer.from(hash)).toEqual(Buffer.from(sha256(referencePreimage())));
  });

  it('network_id equals sha256(utf8(networkPassphrase))', () => {
    const preimage = referencePreimage();
    const netId = preimage.subarray(256 - 32);
    expect(Buffer.from(netId)).toEqual(
      Buffer.from(sha256(Buffer.from(PASSPHRASE, 'utf-8'))),
    );
  });

  it('changing the contract address changes the hash (domain separation)', () => {
    const a = buildWithdrawMessage(STEALTH_PK, TOKEN, AMOUNT, DEST, NONCE, CONTRACT, PASSPHRASE);
    const b = buildWithdrawMessage(
      STEALTH_PK, TOKEN, AMOUNT, DEST, NONCE, 'C' + 'E'.repeat(55), PASSPHRASE,
    );
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('changing the network passphrase changes the hash (domain separation)', () => {
    const a = buildWithdrawMessage(STEALTH_PK, TOKEN, AMOUNT, DEST, NONCE, CONTRACT, PASSPHRASE);
    const b = buildWithdrawMessage(
      STEALTH_PK, TOKEN, AMOUNT, DEST, NONCE, CONTRACT, 'Standalone Network ; February 2017',
    );
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('rejects a non-56-byte contract address', () => {
    expect(() =>
      buildWithdrawMessage(STEALTH_PK, TOKEN, AMOUNT, DEST, NONCE, 'CSHORT', PASSPHRASE),
    ).toThrow(/Contract address must be 56 bytes/);
  });
});
