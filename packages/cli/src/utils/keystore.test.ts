import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from '@noble/hashes/utils';

// Dynamic import to avoid TypeScript compilation issues
const loadKeystore = async (filepath: string, password?: string) => {
  const { loadKeystore: load } = await import('./keystore.js');
  return load(filepath, password);
};

const saveKeystore = async (filepath: string, keystore: any, password?: string) => {
  const { saveKeystore: save } = await import('./keystore.js');
  return save(filepath, keystore, password);
};

const resolveKeystorePath = async (flagValue?: string) => {
  const { resolveKeystorePath: resolve } = await import('./keystore.js');
  return resolve(flagValue);
};

const isKeystoreEncrypted = async (filepath: string) => {
  const { isKeystoreEncrypted: check } = await import('./keystore.js');
  return check(filepath);
};

describe('keystore', () => {
  const tempDir = path.join(os.tmpdir(), 'test-keystore-temp');
  const keystorePath = path.join(tempDir, 'test-keystore.json');
  const password = 'test-password-123';

  beforeEach(async () => {
    try {
      await fs.mkdir(tempDir, { recursive: true });
    } catch {}
  });

  afterEach(async () => {
    try {
      await fs.unlink(keystorePath);
    } catch {}
    try {
      await fs.rmdir(tempDir);
    } catch {}
  });

  it('should save and load keystore with correct encryption', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    await saveKeystore(keystorePath, keystore, password);

    expect(fsSync.existsSync(keystorePath)).toBe(true);

    const loaded = await loadKeystore(keystorePath, password);

    expect(loaded.spendPrivateKey).toEqual(keystore.spendPrivateKey);
    expect(loaded.viewPrivateKey).toEqual(keystore.viewPrivateKey);
    expect(loaded.spendPublicKey).toEqual(keystore.spendPublicKey);
    expect(loaded.viewPublicKey).toEqual(keystore.viewPublicKey);
  });

  it('should throw error with wrong password', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    await saveKeystore(keystorePath, keystore, password);

    await expect(loadKeystore(keystorePath, 'wrong-password')).rejects.toThrow();
  });

  it('should throw error for non-existent keystore', async () => {
    await expect(loadKeystore('/non/existent/path.json', password)).rejects.toThrow();
  });

  it('should create keystore with restricted permissions', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    await saveKeystore(keystorePath, keystore, password);

    const stats = fsSync.statSync(keystorePath);
    const mode = (stats.mode & parseInt('777', 8)).toString(8);

    expect(mode).toBe('600');
  });

  it('refuses an empty-string password but still allows explicit plaintext (undefined)', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    // An empty string is a mistake, not an opt-out: it must throw rather than
    // silently persist unencrypted private keys.
    await expect(saveKeystore(keystorePath, keystore, '')).rejects.toThrow(/empty password/i);

    // `undefined` remains the explicit, intentional plaintext path (used by
    // keygen --plaintext / --no-encrypt).
    await saveKeystore(keystorePath, keystore);
    expect(await isKeystoreEncrypted(keystorePath)).toBe(false);
    const loaded = await loadKeystore(keystorePath);
    expect(loaded.spendPrivateKey).toEqual(keystore.spendPrivateKey);
    expect(loaded.viewPrivateKey).toEqual(keystore.viewPrivateKey);
  });

  it('should store keystore in valid JSON format', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    await saveKeystore(keystorePath, keystore, password);

    const content = await fs.readFile(keystorePath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed).toHaveProperty('encrypted');
    expect(parsed.encrypted).toHaveProperty('data');
    expect(parsed.encrypted).toHaveProperty('salt');
    expect(parsed.encrypted).toHaveProperty('iv');
    expect(parsed).toHaveProperty('version');
    expect(parsed.version).toBe(2);
  });

  it('stores hardened KDF params and round-trips them (CLI-01)', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    await saveKeystore(keystorePath, keystore, password);

    const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
    expect(parsed.encrypted.kdf).toEqual({ N: 131072, r: 8, p: 1 });

    const loaded = await loadKeystore(keystorePath, password);
    expect(loaded.spendPrivateKey).toEqual(keystore.spendPrivateKey);
    expect(loaded.viewPrivateKey).toEqual(keystore.viewPrivateKey);
  });

  /**
   * Write a pre-hardening (version 1, no `kdf` field) envelope encrypted with
   * Node's scrypt defaults (N=16384), returning the plaintext private keys.
   */
  async function writeLegacyEnvelope(filepath: string, pw: string): Promise<{
    spendPrivateKey: string;
    viewPrivateKey: string;
  }> {
    const { createCipheriv, randomBytes: nodeRandom, scryptSync } = await import('crypto');
    const priv = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
    };
    const salt = nodeRandom(32);
    const iv = nodeRandom(16);
    const key = scryptSync(pw, salt, 32); // Node defaults => N=16384
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(priv), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const legacy = {
      version: 1,
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      encrypted: {
        data: Buffer.concat([enc, tag]).toString('base64'),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        // NOTE: no `kdf` field — mirrors a pre-hardening keystore.
      },
    };
    await fs.writeFile(filepath, JSON.stringify(legacy, null, 2));
    return priv;
  }

  it('decrypts a legacy envelope with no KDF params (N=16384 default)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const priv = await writeLegacyEnvelope(keystorePath, password);

    const loaded = await loadKeystore(keystorePath, password);
    expect(loaded.spendPrivateKey).toEqual(priv.spendPrivateKey);
    expect(loaded.viewPrivateKey).toEqual(priv.viewPrivateKey);
    vi.restoreAllMocks();
  });

  it('rewraps a legacy envelope with the hardened KDF on decrypt, then decrypts again (F19)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const priv = await writeLegacyEnvelope(keystorePath, password);

    // First load: decrypts with the legacy fallback AND upgrades the file.
    const first = await loadKeystore(keystorePath, password);
    expect(first.spendPrivateKey).toEqual(priv.spendPrivateKey);

    const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
    expect(parsed.encrypted.kdf).toEqual({ N: 131072, r: 8, p: 1 });
    expect(parsed.version).toBe(2);
    // Public keys survive the rewrap.
    expect(parsed.spendPublicKey).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    // The upgrade is announced (on stderr, not stdout).
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/hardened KDF/i);

    // Second load: the now-hardened envelope round-trips with the same password.
    const second = await loadKeystore(keystorePath, password);
    expect(second.spendPrivateKey).toEqual(priv.spendPrivateKey);
    expect(second.viewPrivateKey).toEqual(priv.viewPrivateKey);
    vi.restoreAllMocks();
  });

  it('a failed rewrap only warns and never fails the load (best-effort)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const priv = await writeLegacyEnvelope(keystorePath, password);

    // Make the file unwritable so the rewrap's save fails with EACCES.
    fsSync.chmodSync(keystorePath, 0o400);
    try {
      const loaded = await loadKeystore(keystorePath, password);
      expect(loaded.spendPrivateKey).toEqual(priv.spendPrivateKey);
      expect(loaded.viewPrivateKey).toEqual(priv.viewPrivateKey);

      const out = errorSpy.mock.calls.flat().join('\n');
      expect(out).toMatch(/could not re-encrypt keystore/i);

      // File is unchanged: still the legacy envelope without KDF params.
      const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
      expect(parsed.version).toBe(1);
      expect(parsed.encrypted.kdf).toBeUndefined();
    } finally {
      fsSync.chmodSync(keystorePath, 0o600);
      vi.restoreAllMocks();
    }
  });

  it('does NOT rewrite an already-hardened keystore on load', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };
    await saveKeystore(keystorePath, keystore, password);
    const before = await fs.readFile(keystorePath, 'utf-8');

    await loadKeystore(keystorePath, password);

    const after = await fs.readFile(keystorePath, 'utf-8');
    // Byte-identical: no pointless re-encryption (new salt/iv) on every load.
    expect(after).toBe(before);
  });
});

describe('resolveKeystorePath', () => {
  const original = process.env.SHADE_KEYSTORE;

  afterEach(() => {
    if (original === undefined) delete process.env.SHADE_KEYSTORE;
    else process.env.SHADE_KEYSTORE = original;
  });

  it('prefers an explicit flag over the env var', async () => {
    process.env.SHADE_KEYSTORE = '/env/path.json';
    expect(await resolveKeystorePath('/flag/path.json')).toBe('/flag/path.json');
  });

  it('falls back to SHADE_KEYSTORE when no flag is given', async () => {
    process.env.SHADE_KEYSTORE = '/env/path.json';
    expect(await resolveKeystorePath(undefined)).toBe('/env/path.json');
  });

  it('falls back to the home default when neither is set', async () => {
    delete process.env.SHADE_KEYSTORE;
    const resolved = await resolveKeystorePath(undefined);
    expect(resolved).toContain('.shade-keys.json');
  });

  it('keygen writes and a read command reads the SAME env-var path', async () => {
    // Simulates the fixed BLOCKING #1 flow: with SHADE_KEYSTORE set and no
    // flag, both writer and reader resolve to the same file.
    const envPath = path.join(os.tmpdir(), 'test-keystore-temp', 'env-keystore.json');
    process.env.SHADE_KEYSTORE = envPath;

    const writePath = await resolveKeystorePath(undefined);
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };
    await saveKeystore(writePath, keystore, 'pw123');

    const readPath = await resolveKeystorePath(undefined);
    expect(readPath).toBe(writePath);

    const loaded = await loadKeystore(readPath, 'pw123');
    expect(loaded.spendPrivateKey).toBe(keystore.spendPrivateKey);

    try {
      fsSync.unlinkSync(envPath);
    } catch {}
  });

  it('detects an encrypted keystore vs a plaintext one', async () => {
    const dir = path.join(os.tmpdir(), 'test-keystore-temp');
    const encPath = path.join(dir, 'enc.json');
    const plainPath = path.join(dir, 'plain.json');
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };

    await saveKeystore(encPath, keystore, 'secret');
    await saveKeystore(plainPath, keystore);

    expect(await isKeystoreEncrypted(encPath)).toBe(true);
    expect(await isKeystoreEncrypted(plainPath)).toBe(false);

    try {
      fsSync.unlinkSync(encPath);
      fsSync.unlinkSync(plainPath);
    } catch {}
  });
});

describe('loadKeystoreOrExit (wrong password vs missing keystore)', () => {
  let dir: string;
  let keystorePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const keystore = {
    spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
    viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
    spendPublicKey: Buffer.from(randomBytes(32)).toString('hex'),
    viewPublicKey: Buffer.from(randomBytes(32)).toString('hex'),
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keystore-orexit-'));
    keystorePath = path.join(dir, 'keys.json');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function errorOutput(): string {
    return errorSpy.mock.calls.flat().join('\n');
  }

  it('missing keystore → suggests shade keygen', async () => {
    const { loadKeystoreOrExit } = await import('./keystore.js');
    const missing = path.join(dir, 'does-not-exist.json');

    await expect(loadKeystoreOrExit(missing, 'any-password')).rejects.toThrow(/exit:1/);

    const out = errorOutput();
    expect(out).toMatch(/no keystore at/i);
    expect(out).toContain(missing);
    expect(out).toMatch(/shade keygen/);
    expect(out).not.toMatch(/wrong password/i);
  });

  it('wrong password → keystore intact, must NOT suggest keygen', async () => {
    const { saveKeystore: save, loadKeystoreOrExit } = await import('./keystore.js');
    await save(keystorePath, keystore, 'right-password');

    await expect(loadKeystoreOrExit(keystorePath, 'wrong-password')).rejects.toThrow(/exit:1/);

    const out = errorOutput();
    expect(out).toMatch(/wrong password or corrupt/i);
    expect(out).toMatch(/keystore is intact/i);
    expect(out).toMatch(/do NOT run 'shade keygen'/);
    expect(out).toMatch(/Try the password again/i);
    // The dangerous hint must be absent: no "run 'shade keygen' first".
    expect(out).not.toMatch(/keygen' first/);

    // And the file really is untouched.
    const { loadKeystore: load } = await import('./keystore.js');
    const reloaded = await load(keystorePath, 'right-password');
    expect(reloaded.spendPrivateKey).toBe(keystore.spendPrivateKey);
  });

  it('corrupt (non-JSON) keystore → treated as unreadable, not missing', async () => {
    const { loadKeystoreOrExit } = await import('./keystore.js');
    await fs.writeFile(keystorePath, 'not json at all {{{');

    await expect(loadKeystoreOrExit(keystorePath, 'pw')).rejects.toThrow(/exit:1/);

    const out = errorOutput();
    expect(out).toMatch(/wrong password or corrupt/i);
    expect(out).not.toMatch(/no keystore at/i);
  });

  it('correct password → returns the decrypted keystore without exiting', async () => {
    const { saveKeystore: save, loadKeystoreOrExit } = await import('./keystore.js');
    await save(keystorePath, keystore, 'right-password');

    const loaded = await loadKeystoreOrExit(keystorePath, 'right-password');
    expect(loaded.spendPrivateKey).toBe(keystore.spendPrivateKey);
    expect(loaded.viewPrivateKey).toBe(keystore.viewPrivateKey);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('readPublicKeys (no password needed)', () => {
  let dir: string;
  let keystorePath: string;

  const keystore = {
    spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
    viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
    spendPublicKey: Buffer.from(randomBytes(32)).toString('hex'),
    viewPublicKey: Buffer.from(randomBytes(32)).toString('hex'),
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keystore-pubkeys-'));
    keystorePath = path.join(dir, 'keys.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads public keys from an ENCRYPTED keystore without the password', async () => {
    const { saveKeystore: save, readPublicKeys } = await import('./keystore.js');
    await save(keystorePath, keystore, 'some-password');

    const pub = await readPublicKeys(keystorePath);
    expect(pub).toEqual({
      spendPublicKey: keystore.spendPublicKey,
      viewPublicKey: keystore.viewPublicKey,
    });
  });

  it('reads public keys from a PLAINTEXT keystore', async () => {
    const { saveKeystore: save, readPublicKeys } = await import('./keystore.js');
    await save(keystorePath, keystore);

    const pub = await readPublicKeys(keystorePath);
    expect(pub).toEqual({
      spendPublicKey: keystore.spendPublicKey,
      viewPublicKey: keystore.viewPublicKey,
    });
  });

  it('throws a clear error when public keys are absent', async () => {
    const { readPublicKeys } = await import('./keystore.js');
    await fs.writeFile(keystorePath, JSON.stringify({ hello: 'world' }));

    await expect(readPublicKeys(keystorePath)).rejects.toThrow(/no public keys/i);
  });

  it('propagates ENOENT for a missing file', async () => {
    const { readPublicKeys } = await import('./keystore.js');
    await expect(readPublicKeys(path.join(dir, 'nope.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});