import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export interface Keystore {
  spendPublicKey: string;
  spendPrivateKey: string;
  viewPublicKey: string;
  viewPrivateKey: string;
}

interface EncryptedKeystore {
  version: number;
  spendPublicKey: string;
  viewPublicKey: string;
  encrypted: {
    data: string;
    salt: string;
    iv: string;
  };
}

const KEYSTORE_PATH = process.env.STEALTH_KEYSTORE || path.join(os.homedir(), '.stealth-keys.json');

export async function saveKeystore(
  filepath: string = KEYSTORE_PATH,
  keystore: Keystore,
  password?: string
): Promise<void> {
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });

  if (password) {
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const key = scryptSync(password, salt, 32);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const privateData = JSON.stringify({
      spendPrivateKey: keystore.spendPrivateKey,
      viewPrivateKey: keystore.viewPrivateKey
    });

    const encrypted = Buffer.concat([
      cipher.update(privateData, 'utf8'),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    const encryptedKeystore: EncryptedKeystore = {
      version: 1,
      spendPublicKey: keystore.spendPublicKey,
      viewPublicKey: keystore.viewPublicKey,
      encrypted: {
        data: Buffer.concat([encrypted, authTag]).toString('base64'),
        salt: salt.toString('base64'),
        iv: iv.toString('base64')
      }
    };

    await fs.writeFile(filepath, JSON.stringify(encryptedKeystore, null, 2));
  } else {
    await fs.writeFile(filepath, JSON.stringify(keystore, null, 2));
  }
}

export async function loadKeystore(
  filepath: string = KEYSTORE_PATH,
  password?: string
): Promise<Keystore> {
  try {
    const data = await fs.readFile(filepath, 'utf-8');
    const parsed = JSON.parse(data);

    if (parsed.encrypted) {
      if (!password) {
        throw new Error('Keystore is encrypted but no password provided');
      }

      const salt = Buffer.from(parsed.encrypted.salt, 'base64');
      const iv = Buffer.from(parsed.encrypted.iv, 'base64');
      const encryptedData = Buffer.from(parsed.encrypted.data, 'base64');

      const key = scryptSync(password, salt, 32);

      const authTag = encryptedData.slice(-16);
      const ciphertext = encryptedData.slice(0, -16);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);

      const privateData = JSON.parse(decrypted.toString('utf8'));

      return {
        spendPublicKey: parsed.spendPublicKey,
        viewPublicKey: parsed.viewPublicKey,
        spendPrivateKey: privateData.spendPrivateKey,
        viewPrivateKey: privateData.viewPrivateKey
      };
    } else {
      return parsed as Keystore;
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`Keystore not found at ${filepath}. Run 'stealth keygen' first.`);
    }
    throw error;
  }
}

export async function keystoreExists(filepath: string = KEYSTORE_PATH): Promise<boolean> {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}