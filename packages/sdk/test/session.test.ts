import { describe, it, expect } from 'vitest';
import { StealthClient } from '../src/client.js';
import { StealthSession, type KVStorage } from '../src/session.js';
import { WrongPasswordError, SessionIntegrityError } from '../src/errors.js';
import type { Payment } from '../src/types.js';

/** In-memory KVStorage satisfying the session's storage contract. */
function memoryStorage(): KVStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe('StealthSession', () => {
  it('save -> unlock roundtrips the keys', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();

    const a = new StealthSession({ storage });
    await a.saveKeys(keys, 'correct horse battery staple');

    // Fresh session, same storage: unlock recovers the same keys.
    const b = new StealthSession({ storage });
    expect(await b.hasKeys()).toBe(true);
    const recovered = await b.unlock('correct horse battery staple');
    expect(recovered).toEqual(keys);
    expect(b.keys.spendPrivKey).toBe(keys.spendPrivKey);
  });

  it('does not store private keys in cleartext', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const s = new StealthSession({ storage });
    await s.saveKeys(keys, 'pw');
    const blob = storage.dump()['stealth:keys']!;
    expect(blob).not.toContain(keys.spendPrivKey);
    expect(blob).not.toContain(keys.viewPrivKey);
    // Public keys are fine in the clear.
    expect(blob).toContain(keys.spendPubKey);
  });

  it('throws WrongPasswordError on a bad password', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const s = new StealthSession({ storage });
    await s.saveKeys(keys, 'right-password');

    const fresh = new StealthSession({ storage });
    await expect(fresh.unlock('wrong-password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('lock() wipes in-memory key material', async () => {
    const keys = StealthClient.keygen();
    const s = new StealthSession({ storage: memoryStorage() });
    await s.saveKeys(keys, 'pw');
    expect(s.keys).toEqual(keys);
    s.lock();
    expect(() => s.keys).toThrow(/locked/);
  });

  it('scan-state cache roundtrips (encrypted)', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const s = new StealthSession({ storage });
    await s.saveKeys(keys, 'pw');

    const payment: Payment = {
      stealthAddress: 'GAAA',
      ephemeralPubKey: 'ab'.repeat(32),
      token: 'native',
      amount: 42,
      amountStroops: '420000000',
      method: 'account',
      txHash: 'HASH',
    };
    const state = {
      cursor: { account: '100' },
      payments: [payment],
      updatedAt: new Date().toISOString(),
    };
    await s.saveScanState(state);

    // scan-state is encrypted, not cleartext.
    const blob = storage.dump()['stealth:scan-state']!;
    expect(blob).not.toContain('GAAA');

    const loaded = await s.loadScanState();
    expect(loaded).toEqual(state);
  });

  it('loadScanState returns null when nothing cached', async () => {
    const keys = StealthClient.keygen();
    const s = new StealthSession({ storage: memoryStorage() });
    await s.saveKeys(keys, 'pw');
    expect(await s.loadScanState()).toBeNull();
  });

  it('clear() removes keys and scan state', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const s = new StealthSession({ storage });
    await s.saveKeys(keys, 'pw');
    await s.saveScanState({ cursor: {}, payments: [], updatedAt: 'now' });
    await s.clear();
    expect(await s.hasKeys()).toBe(false);
    expect(Object.keys(storage.dump())).toHaveLength(0);
  });

  it('unlock THROWS SessionIntegrityError when the cleartext spendPublicKey is tampered (SDK-02)', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const a = new StealthSession({ storage });
    await a.saveKeys(keys, 'pw');

    // A storage-WRITE attacker (no password) swaps the cleartext spend pubkey
    // for a wrong-but-valid one; the private material is still AES-GCM intact.
    const envelope = JSON.parse(storage.dump()['stealth:keys']!);
    const wrongPub = StealthClient.keygen().spendPubKey;
    expect(wrongPub).not.toBe(envelope.spendPublicKey);
    envelope.spendPublicKey = wrongPub;
    await storage.setItem('stealth:keys', JSON.stringify(envelope));

    const b = new StealthSession({ storage });
    await expect(b.unlock('pw')).rejects.toBeInstanceOf(SessionIntegrityError);
  });

  it('unlock THROWS SessionIntegrityError when the cleartext viewPublicKey is tampered (SDK-02)', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const a = new StealthSession({ storage });
    await a.saveKeys(keys, 'pw');

    const envelope = JSON.parse(storage.dump()['stealth:keys']!);
    envelope.viewPublicKey = StealthClient.keygen().viewPubKey;
    await storage.setItem('stealth:keys', JSON.stringify(envelope));

    const b = new StealthSession({ storage });
    await expect(b.unlock('pw')).rejects.toBeInstanceOf(SessionIntegrityError);
  });

  it('an untampered session unlocks normally (integrity check passes)', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const a = new StealthSession({ storage });
    await a.saveKeys(keys, 'pw');

    const b = new StealthSession({ storage });
    await expect(b.unlock('pw')).resolves.toEqual(keys);
  });

  it('respects a custom namespace', async () => {
    const keys = StealthClient.keygen();
    const storage = memoryStorage();
    const s = new StealthSession({ storage, namespace: 'myapp' });
    await s.saveKeys(keys, 'pw');
    expect(Object.keys(storage.dump())).toContain('myapp:keys');
  });
});
