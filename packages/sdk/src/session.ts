import { WrongPasswordError } from './errors.js';
import type { StealthKeys, Payment, ScanCursor } from './types.js';

/**
 * A minimal key/value storage interface. `window.localStorage` satisfies it
 * directly; cookie / IndexedDB / React-Native wrappers are the app's job. All
 * methods may be sync or async so async backends work transparently.
 */
export interface KVStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Options for {@link StealthSession}. */
export interface StealthSessionOpts {
  /** The backing key/value store (e.g. `window.localStorage`). */
  storage: KVStorage;
  /** Storage-key namespace prefix. Default `'stealth'`. */
  namespace?: string;
}

/** Cached scan progress so returning users neither re-key nor rescan from zero. */
export interface ScanState {
  /** Per-method resume cursor. */
  cursor: ScanCursor;
  /** Discovered payments so far. */
  payments: Payment[];
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface Envelope {
  version: 2;
  kdf: 'pbkdf2';
  iterations: number;
  spendPublicKey: string;
  viewPublicKey: string;
  encrypted: { data: string; salt: string; iv: string };
}

interface ScanEnvelope {
  version: 2;
  kdf: 'pbkdf2';
  iterations: number;
  encrypted: { data: string; salt: string; iv: string };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto?.subtle;
  if (!c) {
    throw new Error(
      'WebCrypto SubtleCrypto is unavailable — StealthSession needs a browser or Node 18+.',
    );
  }
  return c;
};

async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptJson(
  value: unknown,
  password: string,
): Promise<{ data: string; salt: string; iv: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return {
    data: toBase64(cipher),
    salt: toBase64(salt),
    iv: toBase64(iv),
  };
}

async function decryptJson<T>(
  encrypted: { data: string; salt: string; iv: string },
  password: string,
  iterations: number,
): Promise<T> {
  const salt = fromBase64(encrypted.salt);
  const iv = fromBase64(encrypted.iv);
  const key = await deriveAesKey(password, salt, iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      fromBase64(encrypted.data) as BufferSource,
    );
  } catch {
    throw new WrongPasswordError();
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/**
 * Storage-agnostic, encrypted web session for stealth keys and scan state.
 *
 * Keys and scan history are encrypted with AES-256-GCM under a PBKDF2-SHA256
 * (600k iterations) key derived from the user's password, using only
 * `globalThis.crypto.subtle` — no new dependencies, works in browsers and Node
 * 18+. This is intentionally separate from the CLI keystore (which stays on
 * Node's scrypt).
 *
 * @example
 * ```typescript
 * const session = new StealthSession({ storage: window.localStorage });
 * await session.saveKeys(keys, password);
 * // ... later / new page load ...
 * await session.unlock(password);
 * const keys = session.keys;
 * ```
 */
export class StealthSession {
  private readonly storage: KVStorage;
  private readonly namespace: string;
  private unlockedKeys: StealthKeys | null = null;
  private password: string | null = null;

  constructor(opts: StealthSessionOpts) {
    this.storage = opts.storage;
    this.namespace = opts.namespace ?? 'stealth';
  }

  private get keysKey(): string {
    return `${this.namespace}:keys`;
  }

  private get scanKey(): string {
    return `${this.namespace}:scan-state`;
  }

  /**
   * Encrypt and persist the stealth keys under the given password. The public
   * keys are stored in the clear (they are shareable); only the private key
   * material is encrypted.
   */
  async saveKeys(keys: StealthKeys, password: string): Promise<void> {
    const encrypted = await encryptJson(
      {
        metaAddress: keys.metaAddress,
        spendPrivKey: keys.spendPrivKey,
        viewPrivKey: keys.viewPrivKey,
      },
      password,
    );
    const envelope: Envelope = {
      version: 2,
      kdf: 'pbkdf2',
      iterations: PBKDF2_ITERATIONS,
      spendPublicKey: keys.spendPubKey,
      viewPublicKey: keys.viewPubKey,
      encrypted,
    };
    await this.storage.setItem(this.keysKey, JSON.stringify(envelope));
    this.unlockedKeys = keys;
    this.password = password;
  }

  /**
   * Decrypt the stored keys into memory using the password.
   *
   * @throws {WrongPasswordError} If the password fails the AES-GCM auth check.
   * @throws If no keys are stored.
   */
  async unlock(password: string): Promise<StealthKeys> {
    const raw = await this.storage.getItem(this.keysKey);
    if (!raw) {
      throw new Error('No stored keys — call saveKeys() first.');
    }
    const envelope = JSON.parse(raw) as Envelope;
    const secret = await decryptJson<{
      metaAddress: string;
      spendPrivKey: string;
      viewPrivKey: string;
    }>(envelope.encrypted, password, envelope.iterations);

    const keys: StealthKeys = {
      metaAddress: secret.metaAddress,
      spendPubKey: envelope.spendPublicKey,
      spendPrivKey: secret.spendPrivKey,
      viewPubKey: envelope.viewPublicKey,
      viewPrivKey: secret.viewPrivKey,
    };
    this.unlockedKeys = keys;
    this.password = password;
    return keys;
  }

  /** The in-memory keys after {@link unlock}/{@link saveKeys}. */
  get keys(): StealthKeys {
    if (!this.unlockedKeys) {
      throw new Error('Session is locked — call unlock() first.');
    }
    return this.unlockedKeys;
  }

  /** Wipe in-memory key material (storage is untouched). */
  lock(): void {
    this.unlockedKeys = null;
    this.password = null;
  }

  /** Whether keys are present in storage (does not require unlock). */
  async hasKeys(): Promise<boolean> {
    return (await this.storage.getItem(this.keysKey)) !== null;
  }

  /** Remove all session data (keys + scan state) and lock in memory. */
  async clear(): Promise<void> {
    await this.storage.removeItem(this.keysKey);
    await this.storage.removeItem(this.scanKey);
    this.lock();
  }

  /**
   * Load the encrypted scan-state cache. Requires an unlocked session (the same
   * derived key protects it, since payment history is private). Returns null
   * when nothing is cached.
   */
  async loadScanState(): Promise<ScanState | null> {
    if (!this.password) {
      throw new Error('Session is locked — call unlock() before loadScanState().');
    }
    const raw = await this.storage.getItem(this.scanKey);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as ScanEnvelope;
    return decryptJson<ScanState>(
      envelope.encrypted,
      this.password,
      envelope.iterations,
    );
  }

  /**
   * Encrypt and persist the scan-state cache under the session password.
   * Requires an unlocked session.
   */
  async saveScanState(state: ScanState): Promise<void> {
    if (!this.password) {
      throw new Error('Session is locked — call unlock() before saveScanState().');
    }
    const encrypted = await encryptJson(state, this.password);
    const envelope: ScanEnvelope = {
      version: 2,
      kdf: 'pbkdf2',
      iterations: PBKDF2_ITERATIONS,
      encrypted,
    };
    await this.storage.setItem(this.scanKey, JSON.stringify(envelope));
  }
}
