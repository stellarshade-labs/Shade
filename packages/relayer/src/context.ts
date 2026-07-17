import { Keypair, Networks, Horizon } from '@stellar/stellar-sdk';
import { CreditLedger } from './ledger.js';
import { ChallengeStore } from './utils/auth.js';

/** Shared, injectable relayer context — set once at startup, read by routes. */
export interface RelayerContext {
  keypair: Keypair;
  network: string;
  networkPassphrase: string;
  horizonUrl: string;
  server: Horizon.Server;
  ledger: CreditLedger;
  /** When true, fee-spending endpoints require + debit credit. */
  requireCredit: boolean;
  /**
   * Max XLM the /sponsor route will fund a new account with — a small bootstrap
   * ceiling, NOT a large-balance faucet.
   */
  sponsorMaxXlm: number;
  /** Per-funder cap (XLM) on outstanding sponsored reserves the relayer fronts. */
  sponsorClaimMaxHeld: number;
  /** Proof-of-control challenge-nonce store for fee-spending endpoints. */
  challenges: ChallengeStore;
}

let ctx: RelayerContext | null = null;

/** Static, per-network relayer configuration. */
export interface RelayerNetworkDefinition {
  horizonUrl: string;
  passphrase: string;
  allowHttp: boolean;
}

/**
 * Supported networks (testnet-only today, table-driven so mainnet can be added
 * post-audit without touching call sites). Self-contained on purpose — the
 * relayer does not import @shade/sdk.
 */
export const RELAYER_NETWORKS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
    allowHttp: false,
  },
  // post-audit: public: { horizonUrl: 'https://horizon.stellar.org',
  //   passphrase: Networks.PUBLIC, allowHttp: false },
} satisfies Record<string, RelayerNetworkDefinition>;

/** Look up a network's definition; throws on unknown networks. */
export function networkDefinitionFor(network: string): RelayerNetworkDefinition {
  const def = (RELAYER_NETWORKS as Record<string, RelayerNetworkDefinition>)[
    network
  ];
  if (!def) {
    throw new Error(
      `Unsupported network '${network}'. Supported: ${Object.keys(RELAYER_NETWORKS).join(', ')}`,
    );
  }
  return def;
}

/** Resolve the Horizon URL for a network label (throws on unknown networks). */
export function horizonUrlFor(network: string): string {
  return networkDefinitionFor(network).horizonUrl;
}

/** Resolve the network passphrase for a network label (throws on unknown networks). */
export function passphraseFor(network: string): string {
  return networkDefinitionFor(network).passphrase;
}

/**
 * Initialize the shared relayer context. Tests can call this with a fabricated
 * context (mock server + in-memory-ish ledger) to exercise routes offline.
 */
export function initContext(
  partial: Partial<RelayerContext> & { keypair: Keypair },
): RelayerContext {
  const network = partial.network ?? process.env.NETWORK ?? 'testnet';
  const networkPassphrase = partial.networkPassphrase ?? passphraseFor(network);
  const horizonUrl = partial.horizonUrl ?? horizonUrlFor(network);
  const server =
    partial.server ??
    new Horizon.Server(horizonUrl, {
      allowHttp: networkDefinitionFor(network).allowHttp,
    });
  const ledger = partial.ledger ?? new CreditLedger();
  const requireCredit =
    partial.requireCredit ?? process.env.RELAYER_REQUIRE_CREDIT === '1';
  const sponsorMaxXlm =
    partial.sponsorMaxXlm ??
    (process.env.SPONSOR_MAX_XLM ? Number(process.env.SPONSOR_MAX_XLM) : 5);
  const sponsorClaimMaxHeld =
    partial.sponsorClaimMaxHeld ??
    (process.env.SPONSOR_CLAIM_MAX_HELD
      ? Number(process.env.SPONSOR_CLAIM_MAX_HELD)
      : 10);
  const challenges = partial.challenges ?? new ChallengeStore();

  ctx = {
    keypair: partial.keypair,
    network,
    networkPassphrase,
    horizonUrl,
    server,
    ledger,
    requireCredit,
    sponsorMaxXlm,
    sponsorClaimMaxHeld,
    challenges,
  };
  return ctx;
}

/** Read the active context (throws if uninitialized). */
export function getContext(): RelayerContext {
  if (!ctx) throw new Error('Relayer context not initialized');
  return ctx;
}

/** Clear the context (test isolation). */
export function resetContext(): void {
  ctx = null;
}
