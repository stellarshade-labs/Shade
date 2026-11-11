import fs from 'fs';
import path from 'path';
import os from 'os';
import { StrKey } from '@stellar/stellar-sdk';
import type { NetworkName } from 'stellar-shade';

const CONFIG_DIR = path.join(os.homedir(), '.stealth');

/** Environment variable that supplies the pool contract when `--contract` is absent. */
export const CONTRACT_ENV_VAR = 'SHADE_CONTRACT';

/** Where a resolved pool contract address came from. */
export type ContractSource = 'flag' | 'env' | 'file';

/** Path of the per-network contract file, `~/.stealth/<network>-contract`. */
export function contractConfigFile(network: NetworkName): string {
  return path.join(CONFIG_DIR, `${network}-contract`);
}

function assertContractId(address: string, source: string): string {
  if (!StrKey.isValidContract(address)) {
    throw new Error(
      `Invalid stealth pool contract address from ${source}: '${address}'. ` +
        'Expected a Soroban contract id (C...).',
    );
  }
  return address;
}

/**
 * Resolve the stealth pool contract address for a network, reporting where it
 * came from. Precedence: the `--contract` flag (`override`), then the
 * `SHADE_CONTRACT` env var, then the per-network file `~/.stealth/<network>-contract`
 * (written by `shade config set-contract`).
 *
 * There is deliberately NO built-in default address — testnet resets
 * periodically and a stale baked-in C-address only produces an opaque Soroban
 * failure later. The current canonical deployment is published in the repo's
 * `deployments/<network>.json`. If none is configured we throw an actionable
 * error naming every way to set it.
 *
 * @throws {Error} When no contract is configured, or the configured value is
 *   not a valid contract id.
 */
export function resolveContractAddress(
  network: NetworkName,
  override?: string,
): { address: string; source: ContractSource } {
  const flag = override?.trim();
  if (flag) return { address: assertContractId(flag, '--contract'), source: 'flag' };

  const env = process.env[CONTRACT_ENV_VAR]?.trim();
  if (env) return { address: assertContractId(env, CONTRACT_ENV_VAR), source: 'env' };

  const configFile = contractConfigFile(network);
  let fromFile: string | undefined;
  try {
    fromFile = fs.readFileSync(configFile, 'utf-8').trim() || undefined;
  } catch {
    // Fall through to the actionable error below.
  }
  if (fromFile) return { address: assertContractId(fromFile, configFile), source: 'file' };

  throw new Error(
    `No stealth pool contract configured for network '${network}'. Pass ` +
      `--contract <C...>, set ${CONTRACT_ENV_VAR}, or run ` +
      `'shade config set-contract <C...>' (writes ${configFile}). The canonical ` +
      `${network} deployment is listed in deployments/${network}.json in the Shade repo.`,
  );
}

/**
 * Resolve just the pool contract address (see {@link resolveContractAddress}).
 *
 * @throws {Error} When no valid contract address is configured for the network.
 */
export function getContractAddress(network: NetworkName, override?: string): string {
  return resolveContractAddress(network, override).address;
}

/**
 * Persist the pool contract address for a network to `~/.stealth/<network>-contract`.
 *
 * @returns The path written.
 * @throws {Error} When `address` is not a valid contract id.
 */
export function saveContractAddress(network: NetworkName, address: string): string {
  const trimmed = assertContractId(address.trim(), 'the given address');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const configFile = contractConfigFile(network);
  fs.writeFileSync(configFile, trimmed);
  return configFile;
}

function horizonCursorFile(network: NetworkName): string {
  return path.join(CONFIG_DIR, `horizon-cursor-${network}`);
}

/** Load the persisted Horizon paging cursor for the account method, if any. */
export function loadHorizonCursor(network: NetworkName): string | undefined {
  try {
    const cursor = fs.readFileSync(horizonCursorFile(network), 'utf-8').trim();
    return cursor || undefined;
  } catch {
    return undefined;
  }
}

/** Persist the Horizon paging cursor for the account method. */
export function saveHorizonCursor(network: NetworkName, cursor: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(horizonCursorFile(network), cursor);
}

/** Clear the persisted Horizon cursor (used by --full-rescan). */
export function clearHorizonCursor(network: NetworkName): void {
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
  /**
   * Exact amount as a decimal `bigint` count of stroops, serialized as a
   * string. Mirrors the SDK `Payment.amountStroops` (required there), so a
   * cached payment can be rehydrated into a `Payment` without a lossy float.
   * Entries written before this field existed are normalized on load.
   */
  amountStroops: string;
  /** Transaction hash that delivered the payment. */
  txHash?: string;
}

/**
 * Derive an exact stroop string from a legacy cached whole-unit amount. Only
 * used to rehydrate cache entries written before `amountStroops` was persisted;
 * those entries never had more precision than this float to begin with.
 */
function stroopsFromLegacyAmount(amount: number): string {
  return BigInt(Math.round(amount * 1e7)).toString();
}

function horizonPaymentsFile(network: NetworkName): string {
  return path.join(CONFIG_DIR, `horizon-payments-${network}.json`);
}

/**
 * Load the persisted account-method payments cache, if any. Entries from an
 * older cache that predate `amountStroops` are normalized so every returned
 * payment carries the exact stroop amount.
 */
export function loadHorizonPayments(network: NetworkName): PersistedPayment[] {
  try {
    const raw = fs.readFileSync(horizonPaymentsFile(network), 'utf-8');
    const parsed = JSON.parse(raw) as (Omit<PersistedPayment, 'amountStroops'> & {
      amountStroops?: string;
    })[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => ({
      ...p,
      amountStroops: p.amountStroops ?? stroopsFromLegacyAmount(p.amount),
    }));
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
  network: NetworkName,
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
export function clearHorizonPayments(network: NetworkName): void {
  try {
    fs.rmSync(horizonPaymentsFile(network));
  } catch {
    // Nothing to clear.
  }
}

/** Look up a persisted account-method payment by its stealth address. */
export function findHorizonPayment(
  network: NetworkName,
  stealthAddress: string,
): PersistedPayment | undefined {
  return loadHorizonPayments(network).find(
    (p) => p.stealthAddress === stealthAddress,
  );
}
