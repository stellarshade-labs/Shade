import chalk from 'chalk';
import { decodeMetaAddress } from '@shade/crypto';
import type { NetworkName } from 'stellar-shade';

/**
 * The networks this CLI accepts today. Mainnet ('public') is added here — and
 * in the SDK's `NETWORKS` table — after the external audit.
 */
export const SUPPORTED_NETWORKS: NetworkName[] = ['testnet'];

/**
 * Validate the transport `--network` flag, exiting on anything unsupported.
 *
 * Previously commands did `options.network as ...` casts and unknown values
 * fell through to the testnet branch, so `--network mainnet` silently built a
 * TESTNET transaction. Only members of {@link SUPPORTED_NETWORKS} pass;
 * anything else (notably 'mainnet' and the removed 'local') prints an error
 * and exits.
 */
export function assertNetwork(value: string): NetworkName {
  if ((SUPPORTED_NETWORKS as string[]).includes(value)) {
    return value as NetworkName;
  }
  console.error(
    chalk.red(
      `Error: unsupported network '${value}'. Supported: ${SUPPORTED_NETWORKS.join(', ')}. ` +
        "('local' has been removed — dev/test runs on testnet; mainnet arrives after the external audit.)",
    ),
  );
  process.exit(1);
  // process.exit never returns; this satisfies the declared return type.
  throw new Error('unreachable');
}

export function formatError(error: any): string {
  if (error?.response?.data?.extras?.result_codes) {
    const codes = error.response.data.extras.result_codes;
    if (codes.transaction) {
      return `Transaction failed: ${codes.transaction}`;
    }
    if (codes.operations?.length > 0) {
      return `Operation failed: ${codes.operations.join(', ')}`;
    }
  }

  if (error?.response?.status === 404) {
    return 'Account not found on network';
  }

  if (error?.response?.status === 400) {
    return 'Invalid request format';
  }

  if (error.code === 'ECONNREFUSED') {
    return 'Cannot connect to network (is the node running?)';
  }

  if (error.code === 'ETIMEDOUT') {
    return 'Network request timed out';
  }

  return error.message || 'Unknown error';
}

export function validateMetaAddress(metaAddress: string): { spendPubKey: Buffer; viewPubKey: Buffer } | null {
  // Try shade:stellar: encoded format first
  if (metaAddress.startsWith('shade:stellar:')) {
    try {
      const decoded = decodeMetaAddress(metaAddress);
      return {
        spendPubKey: Buffer.from(decoded.spendPubKey),
        viewPubKey: Buffer.from(decoded.viewPubKey),
      };
    } catch {
      return null;
    }
  }

  // Fall back to raw hex format: spendHex:viewHex
  const parts = metaAddress.split(':');
  if (parts.length !== 2) {
    return null;
  }

  try {
    if (!parts[0] || !parts[1]) {
      return null;
    }

    const spendPubKey = Buffer.from(parts[0], 'hex');
    const viewPubKey = Buffer.from(parts[1], 'hex');

    if (spendPubKey.length !== 32 || viewPubKey.length !== 32) {
      return null;
    }

    return { spendPubKey, viewPubKey };
  } catch {
    return null;
  }
}