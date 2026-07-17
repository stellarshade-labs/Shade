import { logger } from './utils/logger.js';

/** Static, per-network indexer configuration. */
export interface IndexerNetworkDefinition {
  horizonUrl: string;
}

/**
 * Supported networks (testnet-only today, table-driven so mainnet can be added
 * post-audit without touching call sites). Self-contained on purpose — the
 * indexer does not import @shade/sdk or @stellar/stellar-sdk.
 */
export const INDEXER_NETWORKS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  // post-audit: public: { horizonUrl: 'https://horizon.stellar.org' },
} satisfies Record<string, IndexerNetworkDefinition>;

/**
 * Exit 1 unless `network` is a supported network (a key of INDEXER_NETWORKS).
 *
 * There is no `local` network anymore: dev/test runs against testnet, and
 * additional networks (mainnet) are added to the table post-audit. Rejecting
 * unknown values at boot means no later code path can quietly index a
 * different feed than the operator asked for.
 */
export function assertSupportedNetwork(network: string): string {
  if (network in INDEXER_NETWORKS) return network;
  const supported = Object.keys(INDEXER_NETWORKS).join(', ');
  logger.error('Unsupported NETWORK', {
    network,
    supported,
    message:
      "Refusing to start: 'local' was removed; run against testnet " +
      '(NETWORK=testnet).',
  });
  console.error(
    `[Indexer] FATAL: NETWORK='${network}' is not supported. 'local' was ` +
      'removed; run against testnet (NETWORK=testnet). Supported networks: ' +
      `${supported}.`,
  );
  process.exit(1);
}

/**
 * Resolve the Horizon URL for a network label. An explicit HORIZON_URL env
 * override wins (tests and private Horizons); otherwise the network table
 * (throws on unknown networks).
 */
export function horizonUrlFor(network: string): string {
  const override = process.env.HORIZON_URL?.trim();
  if (override) return override;
  const def = (INDEXER_NETWORKS as Record<string, IndexerNetworkDefinition>)[
    network
  ];
  if (!def) {
    throw new Error(
      `Unsupported network '${network}'. Supported: ${Object.keys(INDEXER_NETWORKS).join(', ')}`,
    );
  }
  return def.horizonUrl;
}
