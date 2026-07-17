import {
  Networks,
  Contract,
  nativeToScVal,
  Asset,
  TransactionBuilder,
  StrKey,
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha256';
import {
  TransactionRetryableError,
  TransactionTimeoutError,
  UnsupportedNetworkError,
} from './errors.js';

/** Static endpoints and passphrase for one supported Stellar network. */
export interface NetworkDefinition {
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  allowHttp: boolean;
}

/**
 * The single source of truth for the networks this SDK can talk to. Adding a
 * network is ONE new entry here: {@link NetworkName} (and with it every
 * `ClientConfig.network` union across the SDK and its consumers) widens
 * automatically.
 */
export const NETWORKS = {
  testnet: {
    networkPassphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    allowHttp: false,
  },
  // post-audit (mainnet): uncomment and fill in the production RPC endpoint.
  // public: {
  //   networkPassphrase: Networks.PUBLIC,
  //   rpcUrl: '<soroban mainnet rpc>',
  //   horizonUrl: 'https://horizon.stellar.org',
  //   allowHttp: false,
  // },
} as const satisfies Record<string, NetworkDefinition>;

/** The names of the currently supported networks (today: `'testnet'`). */
export type NetworkName = keyof typeof NETWORKS;

/** Network configuration resolved from a network name. */
export interface NetworkConfig extends NetworkDefinition {
  server: StellarSdk.rpc.Server;
}

/**
 * Build network config (endpoints + a connected RPC server) from a network
 * name. Unknown names throw {@link UnsupportedNetworkError} — the type system
 * already prevents them, but plain-JS callers and stale configs need the
 * runtime guard too.
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  const def = NETWORKS[network];
  if (!def) {
    throw new UnsupportedNetworkError(network, Object.keys(NETWORKS));
  }
  return {
    ...def,
    server: new StellarSdk.rpc.Server(def.rpcUrl, { allowHttp: def.allowHttp }),
  };
}

/** Create a dummy transaction for read-only contract simulation. */
export function createSimulationTx(
  operation: StellarSdk.xdr.Operation,
  networkPassphrase: string,
): StellarSdk.Transaction {
  return new TransactionBuilder(
    new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
    { fee: '100', networkPassphrase },
  )
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

/** Execute a read-only contract call via simulation. Returns the decoded native result. */
export async function simulateReadOnly(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<unknown | null> {
  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);
  const sim = await server.simulateTransaction(
    createSimulationTx(op, networkPassphrase),
  );

  if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
    return StellarSdk.scValToNative(sim.result.retval);
  }
  return null;
}

/** Resolve an asset string ("native", "XLM", or "CODE:ISSUER") to a SAC contract address. */
export function resolveTokenAddress(
  assetArg: string | undefined,
  networkPassphrase: string,
): string {
  if (!assetArg || assetArg === 'native' || assetArg === 'XLM') {
    return Asset.native().contractId(networkPassphrase);
  }
  const parts = assetArg.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid asset format. Use CODE:ISSUER or "native"');
  }
  return new Asset(parts[0], parts[1]).contractId(networkPassphrase);
}

/**
 * Give a human-readable label for a SAC token contract address (the opaque
 * `C...` string stored in pool announcements). The native XLM SAC has a
 * deterministic contract id — `Asset.native().contractId(passphrase)` — so we
 * detect it and return `'XLM'`; anything else cannot be reversed to CODE:ISSUER
 * from the address alone, so the original `C...` address is returned unchanged.
 *
 * This is what turns a balance/scan row from an unreadable C-address into a
 * recognizable token name for the common (native) case.
 *
 * @param tokenAddress - The token's SAC contract address, or 'native'/'unknown'.
 * @param networkPassphrase - Passphrase used to derive the native SAC id.
 * @returns 'XLM' for the native SAC (or the literal 'native'); otherwise the input.
 */
export function labelForToken(
  tokenAddress: string,
  networkPassphrase: string,
): string {
  if (!tokenAddress || tokenAddress === 'unknown') return tokenAddress;
  if (tokenAddress === 'native' || tokenAddress === 'XLM') return 'XLM';
  try {
    if (tokenAddress === Asset.native().contractId(networkPassphrase)) {
      return 'XLM';
    }
  } catch {
    // Fall through to the raw address.
  }
  return tokenAddress;
}

/**
 * The minimal transaction-status surface of `rpc.Server` needed to poll a tx
 * hash to a terminal status. Structural, so confirm-polling callers (e.g. the
 * `RelayerClient` confirm option) can inject a real server or a test stub.
 */
export interface TransactionStatusSource {
  getTransaction(hash: string): Promise<{ status: string }>;
}

/**
 * Poll for transaction confirmation. Throws on failure or timeout.
 *
 * The timeout is a typed {@link TransactionTimeoutError} carrying the tx hash:
 * a still-PENDING transaction MAY land after we stop polling, so callers must
 * be able to distinguish "gave up waiting" (poll the hash, do NOT resubmit)
 * from a hard failure — a generic error here invites retry loops that
 * double-send funds.
 */
export async function waitForTransaction(
  server: TransactionStatusSource,
  hash: string,
): Promise<void> {
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const result = await server.getTransaction(hash);
      if (result.status === 'SUCCESS') return;
      if (result.status === 'FAILED') throw new Error('Transaction failed on-chain');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Transaction failed on-chain') throw e;
    }
    attempts++;
  }
  throw new TransactionTimeoutError(hash);
}

/**
 * Interpret a `sendTransaction` result and resolve to a landed transaction hash,
 * or throw. Only `SUCCESS` (already landed) and `PENDING` (queued — then polled
 * to completion) count as landed. Every other status means nothing entered the
 * ledger and must NOT return a success receipt (SDK-01):
 * - `ERROR`   -> a hard submission failure (throw).
 * - `TRY_AGAIN_LATER` (and any other non-terminal status) -> the node dropped
 *   the tx without queueing; throw a retryable error so the caller resubmits.
 * - `DUPLICATE` -> the exact tx is already in flight; poll its hash rather than
 *   assuming success.
 */
export async function resolveSendResult(
  server: StellarSdk.rpc.Server,
  result: { status: string; hash: string },
): Promise<string> {
  switch (result.status) {
    case 'SUCCESS':
      return result.hash;
    case 'PENDING':
      await waitForTransaction(server, result.hash);
      return result.hash;
    case 'DUPLICATE':
      await waitForTransaction(server, result.hash);
      return result.hash;
    case 'ERROR':
      throw new Error('Transaction submission failed');
    default:
      throw new TransactionRetryableError(result.status);
  }
}

/** Fetch announcements from the stealth pool contract (paged by start/limit). */
export async function fetchAnnouncements(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
  start = 0,
  limit = 1000,
): Promise<RawAnnouncement[]> {
  const result = await simulateReadOnly(
    contractId,
    'get_announcements',
    [
      nativeToScVal(start, { type: 'u64' }),
      nativeToScVal(limit, { type: 'u64' }),
    ],
    server,
    networkPassphrase,
  );

  if (!result || !Array.isArray(result)) return [];

  return (result as unknown[]).map((ann: unknown) => {
    const a = ann as Record<string, unknown>;
    const stealthPk = new Uint8Array(a.stealth_pk as ArrayLike<number>);
    return {
      ephemeralPubKey: new Uint8Array(a.ephemeral_pk as ArrayLike<number>),
      viewTag: a.view_tag as number,
      stealthPubKey: stealthPk,
      stealthAddress: StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk)),
      token: (a.token as { toString(): string })?.toString?.() || 'unknown',
      amount: BigInt((a.amount as string | number) || 0),
    };
  });
}

/** Cheap freshness check: total announcement count stored in the pool. */
export async function fetchAnnouncementCount(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<number> {
  const result = await simulateReadOnly(
    contractId,
    'get_announcement_count',
    [],
    server,
    networkPassphrase,
  );
  if (result === null || result === undefined) return 0;
  return Number(result as string | number);
}

export interface RawAnnouncement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  stealthPubKey: Uint8Array;
  stealthAddress: string;
  token: string;
  amount: bigint;
}

/** Query the contract balance for a stealth key + token pair. */
export async function queryBalance(
  contractId: string,
  stealthPk: Uint8Array,
  tokenAddress: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const result = await simulateReadOnly(
    contractId,
    'get_balance',
    [nativeToScVal(Buffer.from(stealthPk)), new StellarSdk.Address(tokenAddress).toScVal()],
    server,
    networkPassphrase,
  );
  if (result !== null) return BigInt(result as string | number);
  return 0n;
}

/** Query the nonce for a stealth key. */
export async function queryNonce(
  contractId: string,
  stealthPk: Uint8Array,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const result = await simulateReadOnly(
    contractId,
    'get_nonce',
    [nativeToScVal(Buffer.from(stealthPk))],
    server,
    networkPassphrase,
  );
  if (result !== null) return BigInt(result as string | number);
  return 0n;
}

function i128ToBigEndian(value: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setBigInt64(0, value >> 64n);
  dv.setBigUint64(8, value & 0xFFFFFFFFFFFFFFFFn);
  return buf;
}

function u64ToBigEndian(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, value);
  return buf;
}

/**
 * Build the withdraw message hash. Must be byte-identical to the contract's
 * `build_withdraw_message`.
 *
 * Layout (concatenated, then SHA-256):
 *   stealth_pk[32] || token_strkey_ascii[56] || amount_be_i128[16]
 *   || dest_strkey_ascii[56] || nonce_be_u64[8]
 *   || contract_strkey_ascii[56] || network_id[32]
 *
 * The trailing contract address and network id provide domain separation so a
 * signature cannot be replayed on a different deployment or network.
 * `networkId` equals `SHA-256(utf8(networkPassphrase))`, which matches the
 * on-chain `env.ledger().network_id()`.
 */
export function buildWithdrawMessage(
  stealthPk: Uint8Array,
  tokenAddress: string,
  amount: bigint,
  destination: string,
  nonce: bigint,
  contractId: string,
  networkPassphrase: string,
): Uint8Array {
  const tokenBytes = Buffer.from(tokenAddress, 'utf-8');
  const destBytes = Buffer.from(destination, 'utf-8');
  const contractBytes = Buffer.from(contractId, 'utf-8');
  if (tokenBytes.length !== 56) throw new Error(`Token address must be 56 bytes StrKey, got ${tokenBytes.length}`);
  if (destBytes.length !== 56) throw new Error(`Destination must be 56 bytes StrKey, got ${destBytes.length}`);
  if (contractBytes.length !== 56) throw new Error(`Contract address must be 56 bytes StrKey, got ${contractBytes.length}`);

  const amountBytes = i128ToBigEndian(amount);
  const nonceBytes = u64ToBigEndian(nonce);
  const networkId = sha256(Buffer.from(networkPassphrase, 'utf-8'));

  const msg = new Uint8Array(32 + 56 + 16 + 56 + 8 + 56 + 32);
  let offset = 0;
  msg.set(stealthPk, offset); offset += 32;
  msg.set(tokenBytes, offset); offset += 56;
  msg.set(amountBytes, offset); offset += 16;
  msg.set(destBytes, offset); offset += 56;
  msg.set(nonceBytes, offset); offset += 8;
  msg.set(contractBytes, offset); offset += 56;
  msg.set(networkId, offset);

  return sha256(msg);
}
