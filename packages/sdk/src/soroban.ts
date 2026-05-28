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

/** Network configuration resolved from a network name. */
export interface NetworkConfig {
  networkPassphrase: string;
  rpcUrl: string;
  server: StellarSdk.rpc.Server;
}

/** Build network config from a network name. */
export function getNetworkConfig(network: 'local' | 'testnet'): NetworkConfig {
  const networkPassphrase = network === 'local'
    ? Networks.STANDALONE
    : Networks.TESTNET;

  const rpcUrl = network === 'local'
    ? 'http://localhost:8000/soroban/rpc'
    : 'https://soroban-testnet.stellar.org';

  const server = new StellarSdk.rpc.Server(rpcUrl, {
    allowHttp: network === 'local',
  });

  return { networkPassphrase, rpcUrl, server };
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

/** Poll for transaction confirmation. Throws on failure or timeout. */
export async function waitForTransaction(
  server: StellarSdk.rpc.Server,
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
  throw new Error('Transaction confirmation timed out');
}

/** Fetch announcements from the stealth pool contract. */
export async function fetchAnnouncements(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<RawAnnouncement[]> {
  const result = await simulateReadOnly(
    contractId,
    'get_announcements',
    [nativeToScVal(0, { type: 'u64' }), nativeToScVal(1000, { type: 'u64' })],
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

/** Build the withdraw message hash. Must be byte-identical to the contract's build_withdraw_message. */
export function buildWithdrawMessage(
  stealthPk: Uint8Array,
  tokenAddress: string,
  amount: bigint,
  destination: string,
  nonce: bigint,
): Uint8Array {
  const tokenBytes = Buffer.from(tokenAddress, 'utf-8');
  const destBytes = Buffer.from(destination, 'utf-8');
  if (tokenBytes.length !== 56) throw new Error(`Token address must be 56 bytes StrKey, got ${tokenBytes.length}`);
  if (destBytes.length !== 56) throw new Error(`Destination must be 56 bytes StrKey, got ${destBytes.length}`);

  const amountBytes = i128ToBigEndian(amount);
  const nonceBytes = u64ToBigEndian(nonce);

  const msg = new Uint8Array(32 + 56 + 16 + 56 + 8);
  let offset = 0;
  msg.set(stealthPk, offset); offset += 32;
  msg.set(tokenBytes, offset); offset += 56;
  msg.set(amountBytes, offset); offset += 16;
  msg.set(destBytes, offset); offset += 56;
  msg.set(nonceBytes, offset);

  return sha256(msg);
}
