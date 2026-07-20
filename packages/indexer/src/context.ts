import { logger } from './utils/logger.js';

/** Static, per-network indexer configuration. */
export interface IndexerNetworkDefinition {
  horizonUrl: string;
  /**
   * The network's passphrase, compared against the Horizon root document by
   * the continuity check so retention bounds from a wrong-network Horizon
   * (e.g. a mistyped HORIZON_URL) can never record a false permanent gap.
   * Plain constants on purpose — the indexer does not import stellar-sdk.
   */
  networkPassphrase: string;
}

/**
 * Supported networks (testnet-only today, table-driven so mainnet can be added
 * post-audit without touching call sites). Self-contained on purpose — the
 * indexer does not import stellar-shade or @stellar/stellar-sdk.
 */
export const INDEXER_NETWORKS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  // post-audit: public: { horizonUrl: 'https://horizon.stellar.org',
  //   networkPassphrase: 'Public Global Stellar Network ; September 2015' },
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

/**
 * The expected network passphrase for a network label (throws on unknown
 * networks). NOT overridable by env: even a private Horizon (HORIZON_URL
 * override) must serve the same chain the deployment claims to index.
 */
export function networkPassphraseFor(network: string): string {
  const def = (INDEXER_NETWORKS as Record<string, IndexerNetworkDefinition>)[
    network
  ];
  if (!def) {
    throw new Error(
      `Unsupported network '${network}'. Supported: ${Object.keys(INDEXER_NETWORKS).join(', ')}`,
    );
  }
  return def.networkPassphrase;
}
