import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('should handle keystore with empty password', async () => {
    const keystore = {
      spendPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      viewPrivateKey: Buffer.from(randomBytes(32)).toString('hex'),
      spendPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      viewPublicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    };

    await saveKeystore(keystorePath, keystore, '');

    const loaded = await loadKeystore(keystorePath, '');

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
    expect(parsed.version).toBe(1);
  });
});