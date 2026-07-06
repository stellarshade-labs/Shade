import { Keypair, Networks, Horizon } from '@stellar/stellar-sdk';
import { CreditLedger } from './ledger.js';

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
  /** Max XLM the /sponsor route will fund a new account with. */
  sponsorMaxXlm: number;
}

let ctx: RelayerContext | null = null;

/** Resolve the Horizon URL for a network label. */
export function horizonUrlFor(network: string): string {
  return network === 'local'
    ? 'http://localhost:8000'
    : 'https://horizon-testnet.stellar.org';
}

/** Resolve the network passphrase for a network label. */
export function passphraseFor(network: string): string {
  return network === 'local' ? Networks.STANDALONE : Networks.TESTNET;
}

/**
 * Initialize the shared relayer context. Tests can call this with a fabricated
 * context (mock server + in-memory-ish ledger) to exercise routes offline.
 */
export function initContext(
  partial: Partial<RelayerContext> & { keypair: Keypair },
): RelayerContext {
  const network = partial.network ?? process.env.NETWORK ?? 'local';
  const networkPassphrase = partial.networkPassphrase ?? passphraseFor(network);
  const horizonUrl = partial.horizonUrl ?? horizonUrlFor(network);
  const server =
    partial.server ??
    new Horizon.Server(horizonUrl, { allowHttp: network === 'local' });
  const ledger = partial.ledger ?? new CreditLedger();
  const requireCredit =
    partial.requireCredit ?? process.env.RELAYER_REQUIRE_CREDIT === '1';
  const sponsorMaxXlm =
    partial.sponsorMaxXlm ??
    (process.env.SPONSOR_MAX_XLM ? Number(process.env.SPONSOR_MAX_XLM) : 1000);

  ctx = {
    keypair: partial.keypair,
    network,
    networkPassphrase,
    horizonUrl,
    server,
    ledger,
    requireCredit,
    sponsorMaxXlm,
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
