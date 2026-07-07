import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { ChallengeStore, challengeMessage } from './auth.js';

function sign(kp: Keypair, endpoint: string, nonce: string, amount: string): string {
  const msg = challengeMessage(endpoint, kp.publicKey(), nonce, amount);
  return kp.sign(Buffer.from(msg, 'utf8')).toString('base64');
}

describe('ChallengeStore proof-of-control', () => {
  it('accepts a valid signed nonce and consumes it (single-use)', () => {
    const store = new ChallengeStore();
    const kp = Keypair.random();
    const nonce = store.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '0.0000600');

    const err = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '0.0000600',
    );
    expect(err).toBeNull();

    // Reused nonce is rejected.
    const replay = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '0.0000600',
    );
    expect(replay).toBe('invalid_nonce');
  });

  it('rejects a missing signature', () => {
    const store = new ChallengeStore();
    const kp = Keypair.random();
    const nonce = store.issue(kp.publicKey());
    const err = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce },
      '1',
    );
    expect(err).toBe('missing_auth');
  });

  it('rejects a signature from the wrong signer', () => {
    const store = new ChallengeStore();
    const kp = Keypair.random();
    const attacker = Keypair.random();
    const nonce = store.issue(kp.publicKey());
    // Attacker signs the message but claims to be kp.
    const signature = sign(attacker, 'relay', nonce, '1');
    const err = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(err).toBe('invalid_signature');
  });

  it('rejects an unknown nonce', () => {
    const store = new ChallengeStore();
    const kp = Keypair.random();
    const signature = sign(kp, 'relay', 'deadbeef', '1');
    const err = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce: 'deadbeef', signature },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('rejects an expired nonce', () => {
    const store = new ChallengeStore(0); // immediate expiry
    const kp = Keypair.random();
    const nonce = store.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');
    const err = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('rejects a nonce issued for a different account', () => {
    const store = new ChallengeStore();
    const kp = Keypair.random();
    const other = Keypair.random();
    const nonce = store.issue(other.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');
    const err = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('rejects a signature bound to a different endpoint or amount', () => {
    const store = new ChallengeStore();
    const kp = Keypair.random();
    const nonce = store.issue(kp.publicKey());
    // Signed for 'relay'/amount 1 but verified for 'sponsor'/amount 1.
    const signature = sign(kp, 'relay', nonce, '1');
    const endpointMismatch = store.verify(
      'sponsor',
      { fundingAccount: kp.publicKey(), nonce, signature },
      '1',
    );
    expect(endpointMismatch).toBe('invalid_signature');

    const nonce2 = store.issue(kp.publicKey());
    const sig2 = sign(kp, 'relay', nonce2, '1');
    const amountMismatch = store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce: nonce2, signature: sig2 },
      '2',
    );
    expect(amountMismatch).toBe('invalid_signature');
  });
});
