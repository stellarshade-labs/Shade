import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export interface Keystore {
  spendPublicKey: string;
  spendPrivateKey: string;
  viewPublicKey: string;
  viewPrivateKey: string;
}

/** scrypt KDF parameters persisted in the envelope so hardening can evolve. */
interface KdfParams {
  N: number;
  r: number;
  p: number;
}

interface EncryptedKeystore {
  version: number;
  spendPublicKey: string;
  viewPublicKey: string;
  encrypted: {
    data: string;
    salt: string;
    iv: string;
    /** Present from envelope v2 onward; absent envelopes use LEGACY_KDF. */
    kdf?: KdfParams;
  };
}

/**
 * Hardened scrypt work factor for NEW keystores (~0.15s/guess). `maxmem` MUST be
 * raised above Node's 32 MB default or scrypt throws for these parameters.
 */
const HARDENED_KDF: KdfParams = { N: 131072, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * Node's scrypt defaults, used to decrypt pre-existing envelopes that were
 * written before KDF params were stored (version 1, no `kdf` field).
 */
const LEGACY_KDF: KdfParams = { N: 16384, r: 8, p: 1 };

/** Envelope version written by the current hardened save path. */
const KEYSTORE_VERSION = 2;

/** Derive the AES key from a password using the given (stored) KDF params. */
function deriveKey(password: string, salt: Buffer, kdf: KdfParams): Buffer {
  return scryptSync(password, salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** The home-directory default keystore location. */
export const DEFAULT_KEYSTORE_PATH = path.join(os.homedir(), '.shade-keys.json');

/**
 * Resolve the keystore path from a single source of truth so `keygen` (writes)
 * and the read commands (scan/balance/claim/withdraw) always agree.
 *
 * Precedence: an explicit `--keystore` flag wins, then the `SHADE_KEYSTORE`
 * environment variable, then the home-directory default. Previously `keygen`
 * ignored `SHADE_KEYSTORE` while the read commands honored it, so a keystore
 * written by `keygen` could not be found by a scan pointed at the env var.
 */
export function resolveKeystorePath(flagValue?: string): string {
  if (flagValue) return flagValue;
  if (process.env.SHADE_KEYSTORE) return process.env.SHADE_KEYSTORE;
  return DEFAULT_KEYSTORE_PATH;
}

const KEYSTORE_PATH = resolveKeystorePath();

/** True when the keystore file on disk is an encrypted (password-protected) envelope. */
export async function isKeystoreEncrypted(
  filepath: string = KEYSTORE_PATH,
): Promise<boolean> {
  try {
    const data = await fs.readFile(filepath, 'utf-8');
    const parsed = JSON.parse(data);
    return !!parsed.encrypted;
  } catch {
    return false;
  }
}

/**
 * Prompt for a secret on stderr without echoing keystrokes to the terminal.
 *
 * When stdin is a TTY, terminal echo is disabled via raw mode so typed
 * characters never appear on screen or in scrollback; bytes are accumulated
 * until CR/LF, with backspace and Ctrl-C handled. When stdin is not a TTY
 * (piped/redirected input) it falls back to a line read via readline, which
 * has no terminal echo to suppress.
 */
export function promptPassword(question: string): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream & {
    isTTY?: boolean;
    isRawMode?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const stderr = process.stderr;

  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return new Promise((resolve, reject) => {
      stderr.write(question);
      let input = '';
      const wasRaw = stdin.isRawMode ?? false;
      stdin.setRawMode!(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const cleanup = (): void => {
        stdin.removeListener('data', onData);
        stdin.setRawMode!(wasRaw);
        stdin.pause();
        stderr.write('\n');
      };

      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          switch (ch) {
            case '\r':
            case '\n':
              cleanup();
              resolve(input.trim());
              return;
            case '\u0003': // Ctrl-C
              cleanup();
              reject(new Error('Aborted'));
              return;
            case '\u007f': // Backspace/DEL
            case '\b':
              input = input.slice(0, -1);
              break;
            default:
              if (ch >= ' ') input += ch;
              break;
          }
        }
      };

      stdin.on('data', onData);
    });
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: stderr });
    rl.question(question, (answer) => {
      rl.close();
      stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

/**
 * Load a keystore, transparently handling encryption: if the file is encrypted
 * and no password was provided, prompt for one on stderr. Read commands use this
 * so an encrypted keystore round-trips without every command re-implementing the
 * prompt.
 */
export async function loadKeystoreInteractive(
  filepath: string = KEYSTORE_PATH,
  password?: string,
): Promise<Keystore> {
  let pw = password;
  if (pw === undefined && (await isKeystoreEncrypted(filepath))) {
    pw = await promptPassword('Enter keystore password: ');
  }
  return loadKeystore(filepath, pw);
}

export async function saveKeystore(
  filepath: string = KEYSTORE_PATH,
  keystore: Keystore,
  password?: string
): Promise<void> {
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });

  // An empty-string password is a mistake, not a request for plaintext: it would
  // silently write unencrypted private keys. Only `undefined` (the --plaintext /
  // --no-encrypt path) intentionally opts out of encryption.
  if (password === '') {
    throw new Error(
      'Refusing to write a keystore with an empty password. Provide a non-empty ' +
        'password to encrypt, or omit the password entirely to intentionally write ' +
        'an unencrypted keystore.',
    );
  }

  if (password) {
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const kdf = HARDENED_KDF;
    const key = deriveKey(password, salt, kdf);

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
      version: KEYSTORE_VERSION,
      spendPublicKey: keystore.spendPublicKey,
      viewPublicKey: keystore.viewPublicKey,
      encrypted: {
        data: Buffer.concat([encrypted, authTag]).toString('base64'),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        kdf
      }
    };

    await fs.writeFile(filepath, JSON.stringify(encryptedKeystore, null, 2), { mode: 0o600 });
  } else {
    await fs.writeFile(filepath, JSON.stringify(keystore, null, 2), { mode: 0o600 });
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

      // Read the KDF params from the envelope so hardened keystores decrypt with
      // their stored work factor; pre-existing envelopes with no params fall back
      // to Node's scrypt defaults (N=16384) so they still decrypt.
      const kdf: KdfParams = parsed.encrypted.kdf ?? LEGACY_KDF;
      const key = deriveKey(password, salt, kdf);

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
      throw new Error(`Keystore not found at ${filepath}. Run 'shade keygen' first.`);
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