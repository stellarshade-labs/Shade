import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.stealth');

export function getContractAddress(network: 'local' | 'testnet'): string {
  const configFile = path.join(CONFIG_DIR, `${network}-contract`);

  try {
    const address = fs.readFileSync(configFile, 'utf-8').trim();
    if (address) return address;
  } catch {
    // Fall through to defaults
  }

  // Default addresses (these should be updated after deployment)
  if (network === 'local') {
    // Try to read from project config first
    try {
      const projectConfig = path.join(process.cwd(), 'packages/cli/.stealth/local-contract');
      const address = fs.readFileSync(projectConfig, 'utf-8').trim();
      if (address) return address;
    } catch {
      // Use fallback
    }
    return 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGABAX';
  } else {
    return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  }
}

export function saveContractAddress(network: 'local' | 'testnet', address: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const configFile = path.join(CONFIG_DIR, `${network}-contract`);
  fs.writeFileSync(configFile, address);
}

function horizonCursorFile(network: 'local' | 'testnet'): string {
  return path.join(CONFIG_DIR, `horizon-cursor-${network}`);
}

/** Load the persisted Horizon paging cursor for the account method, if any. */
export function loadHorizonCursor(network: 'local' | 'testnet'): string | undefined {
  try {
    const cursor = fs.readFileSync(horizonCursorFile(network), 'utf-8').trim();
    return cursor || undefined;
  } catch {
    return undefined;
  }
}

/** Persist the Horizon paging cursor for the account method. */
export function saveHorizonCursor(network: 'local' | 'testnet', cursor: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(horizonCursorFile(network), cursor);
}

/** Clear the persisted Horizon cursor (used by --full-rescan). */
export function clearHorizonCursor(network: 'local' | 'testnet'): void {
  try {
    fs.rmSync(horizonCursorFile(network));
  } catch {
    // Nothing to clear.
  }
}

/**
 * A discovered account-method payment persisted between scans. `scan` advances
 * the Horizon cursor and would otherwise DISCARD the payments it found, so a
 * discovered payment must be cached to disk for the `claim` command to resolve
 * it later by stealth address without a full rescan.
 */
export interface PersistedPayment {
  /** The stealth address holding the funds. */
  stealthAddress: string;
  /** Ephemeral public key R (hex) needed to recover the stealth private key. */
  ephemeralPubKey: string;
  /** Token: 'native' for XLM sends, or the "CODE:ISSUER" asset for token sends. */
  token: string;
  /** Asset in "CODE:ISSUER" form (token claims only). */
  asset?: string;
  /** Claimable balance id (token claims only). */
  claimableBalanceId?: string;
  /** Amount in whole units. */
  amount: number;
  /** Transaction hash that delivered the payment. */
  txHash?: string;
}

function horizonPaymentsFile(network: 'local' | 'testnet'): string {
  return path.join(CONFIG_DIR, `horizon-payments-${network}.json`);
}

/** Load the persisted account-method payments cache, if any. */
export function loadHorizonPayments(
  network: 'local' | 'testnet',
): PersistedPayment[] {
  try {
    const raw = fs.readFileSync(horizonPaymentsFile(network), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedPayment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Merge newly discovered account-method payments into the on-disk cache,
 * de-duplicating on (stealthAddress, txHash, claimableBalanceId). Existing
 * entries are preserved so a cursor-advanced scan never loses earlier finds.
 */
export function saveHorizonPayments(
  network: 'local' | 'testnet',
  payments: PersistedPayment[],
): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = loadHorizonPayments(network);
  const byKey = new Map<string, PersistedPayment>();
  const keyOf = (p: PersistedPayment): string =>
    `${p.stealthAddress}|${p.txHash ?? ''}|${p.claimableBalanceId ?? ''}`;
  for (const p of existing) byKey.set(keyOf(p), p);
  for (const p of payments) byKey.set(keyOf(p), p);
  fs.writeFileSync(
    horizonPaymentsFile(network),
    JSON.stringify([...byKey.values()], null, 2),
  );
}

/** Clear the persisted account-method payments cache (used by --full-rescan). */
export function clearHorizonPayments(network: 'local' | 'testnet'): void {
  try {
    fs.rmSync(horizonPaymentsFile(network));
  } catch {
    // Nothing to clear.
  }
}

/** Look up a persisted account-method payment by its stealth address. */
export function findHorizonPayment(
  network: 'local' | 'testnet',
  stealthAddress: string,
): PersistedPayment | undefined {
  return loadHorizonPayments(network).find(
    (p) => p.stealthAddress === stealthAddress,
  );
}