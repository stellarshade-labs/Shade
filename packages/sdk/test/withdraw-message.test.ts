import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { buildWithdrawMessage } from '../src/soroban.js';

// Fixed inputs used to pin the domain-separated preimage layout (SH-3):
//   domain_tag[22] ("SHADE-POOL-WITHDRAW-V1" ASCII) || stealth_pk[32]
//   || token_strkey_ascii[56] || amount_be_i128[16]
//   || dest_strkey_ascii[56] || nonce_be_u64[8]
//   || contract_strkey_ascii[56] || network_id[32]          = 278 bytes
//
// The fixtures are VALID StrKeys (token = C-strkey of 32x0x03, destination =
// G-strkey of 32x0x02, contract = C-strkey of 32x0x04) so the exact same
// inputs are replayable inside the Rust contract's test env. The Rust test
// `test_withdraw_message_matches_cross_language_vector` in
// contracts/registry/src/lib.rs feeds these same inputs to the on-chain
// `build_withdraw_message` and asserts the same EXPECTED_HASH — a one-byte
// layout divergence on either side breaks one of the two pins.
const DOMAIN_TAG = 'SHADE-POOL-WITHDRAW-V1'; // 22 ASCII bytes
const STEALTH_PK = new Uint8Array(32).fill(1);
const TOKEN = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3';
const DEST = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';
const CONTRACT = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const AMOUNT = 1234567n;
const NONCE = 7n;

// Vector computed once FROM THE IN-TEST REFERENCE IMPL below (independent of
// src/soroban.ts), and cross-pinned in the Rust contract test (see above).
const EXPECTED_HASH =
  '36f8961f900c421b73137c054af96f4fe7d84023fb6db31dd57aba530634c1fc';

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
  const tagB = Buffer.from(DOMAIN_TAG, 'utf-8');
  const tokenB = Buffer.from(TOKEN, 'utf-8');
  const destB = Buffer.from(DEST, 'utf-8');
  const contractB = Buffer.from(CONTRACT, 'utf-8');
  const netId = sha256(Buffer.from(PASSPHRASE, 'utf-8'));
  const msg = new Uint8Array(22 + 32 + 56 + 16 + 56 + 8 + 56 + 32);
  let o = 0;
  msg.set(tagB, o); o += 22;
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
  it('preimage is exactly 278 bytes (22+32+56+16+56+8+56+32)', () => {
    expect(referencePreimage().length).toBe(278);
  });

  it('preimage starts with the exact domain-tag bytes', () => {
    const head = referencePreimage().subarray(0, 22);
    expect(Buffer.from(head)).toEqual(
      Buffer.from('SHADE-POOL-WITHDRAW-V1', 'utf-8'),
    );
    // ASCII spelled out in hex so an accidental tag edit cannot self-confirm.
    expect(Buffer.from(head).toString('hex')).toBe(
      '53484144452d504f4f4c2d57495448445241572d5631',
    );
  });

  it('matches the pinned SHA-256 vector (same hex pinned in the Rust contract test)', () => {
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
    const netId = preimage.subarray(278 - 32);
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
