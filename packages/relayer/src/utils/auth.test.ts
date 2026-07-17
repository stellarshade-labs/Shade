import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { MemoryChallengeStore, challengeMessage } from './auth.js';

function sign(kp: Keypair, endpoint: string, nonce: string, amount: string): string {
  const msg = challengeMessage(endpoint, kp.publicKey(), nonce, amount);
  return kp.sign(Buffer.from(msg, 'utf8')).toString('base64');
}

describe('ChallengeStore proof-of-control', () => {
  it('accepts a valid signed nonce and consumes it (single-use)', async () => {
    const store = new MemoryChallengeStore();
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '0.0000600');

    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '0.0000600',
    );
    expect(err).toBeNull();

    // Reused nonce is rejected.
    const replay = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '0.0000600',
    );
    expect(replay).toBe('invalid_nonce');
  });

  it('rejects a missing signature', async () => {
    const store = new MemoryChallengeStore();
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce },
      '1',
    );
    expect(err).toBe('missing_auth');
  });

  it('rejects a signature from the wrong signer', async () => {
    const store = new MemoryChallengeStore();
    const kp = Keypair.random();
    const attacker = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    // Attacker signs the message but claims to be kp.
    const signature = sign(attacker, 'relay', nonce, '1');
    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(err).toBe('invalid_signature');
  });

  it('rejects an unknown nonce', async () => {
    const store = new MemoryChallengeStore();
    const kp = Keypair.random();
    const signature = sign(kp, 'relay', 'deadbeef', '1');
    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce: 'deadbeef', signature },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('rejects an expired nonce', async () => {
    const store = new MemoryChallengeStore(0); // immediate expiry
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');
    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('rejects a nonce issued for a different account', async () => {
    const store = new MemoryChallengeStore();
    const kp = Keypair.random();
    const other = Keypair.random();
    const nonce = await store.issue(other.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');
    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('rejects a signature bound to a different endpoint or amount', async () => {
    const store = new MemoryChallengeStore();
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    // Signed for 'relay'/amount 1 but verified for 'sponsor'/amount 1.
    const signature = sign(kp, 'relay', nonce, '1');
    const endpointMismatch = await store.verify(
      'sponsor',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(endpointMismatch).toBe('invalid_signature');

    const nonce2 = await store.issue(kp.publicKey());
    const sig2 = sign(kp, 'relay', nonce2, '1');
    const amountMismatch = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce: nonce2, signature: sig2 },
      '2',
    );
    expect(amountMismatch).toBe('invalid_signature');
  });
});
