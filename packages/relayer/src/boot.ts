import path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { RELAYER_NETWORKS } from './context.js';
import { logger } from './utils/logger.js';

/**
 * Exit 1 unless `network` is a supported network (a key of RELAYER_NETWORKS).
 *
 * There is no `local` network anymore: dev/test runs against testnet, and
 * additional networks (mainnet) are added to the table post-audit. Rejecting
 * unknown values at boot means no later code path can quietly fall back to a
 * different network than the operator asked for.
 */
export function assertSupportedNetwork(network: string): string {
  if (network in RELAYER_NETWORKS) return network;
  const supported = Object.keys(RELAYER_NETWORKS).join(', ');
  logger.error('Unsupported NETWORK', {
    network,
    supported,
    message:
      "Refusing to start: 'local' was removed; run against testnet " +
      '(NETWORK=testnet).',
  });
  console.error(
    `[Relayer] FATAL: NETWORK='${network}' is not supported. 'local' was ` +
      'removed; run against testnet (NETWORK=testnet). Supported networks: ' +
      `${supported}.`,
  );
  process.exit(1);
}

/**
 * Resolve the relayer's signing keypair from RELAYER_SECRET.
 *
 * A configured, funded secret is mandatory — there is no dev fallback. A
 * randomly generated keypair is unfunded, so the relayer would boot
 * "successfully" but be unable to pay a single fee — every relay/sponsor
 * request would silently fail. Fail fast (exit 1) instead of limping along.
 */
export function resolveRelayerKeypair(secret: string | undefined): Keypair {
  if (!secret) {
    logger.error('RELAYER_SECRET is required (there is no dev fallback)', {
      message:
        'Refusing to start: a randomly generated keypair is unfunded and can ' +
        'never pay fees. Set RELAYER_SECRET to the secret key (S...) of a ' +
        'funded account and restart.',
    });
    console.error(
      '[Relayer] FATAL: RELAYER_SECRET is required (there is no dev ' +
        'fallback): set it to the secret of a funded account and restart.',
    );
    process.exit(1);
  }

  const keypair = Keypair.fromSecret(secret);
  logger.info('Using configured keypair', { publicKey: keypair.publicKey() });
  return keypair;
}

/** How the effective credit-gating value was resolved, for the startup log. */
export interface RequireCreditResolution {
  requireCredit: boolean;
  /** Human-readable WHY, e.g. "default (credit gating is always on; …)". */
  reason: string;
}

/**
 * Resolve whether credit gating is required (secure-by-default).
 *
 * When RELAYER_REQUIRE_CREDIT is set it always wins ('1' = on, anything else
 * = off). When it is UNSET, credit gating is ALWAYS ON — on every network —
 * so an unconfigured deploy cannot be drained through unauthenticated /relay
 * and /sponsor-claim/submit calls.
 */
export function resolveRequireCredit(
  raw: string | undefined,
): RequireCreditResolution {
  if (raw !== undefined) {
    return {
      requireCredit: raw === '1',
      reason: `RELAYER_REQUIRE_CREDIT=${raw} set explicitly`,
    };
  }
  return {
    requireCredit: true,
    reason:
      'default (credit gating is always on; override with RELAYER_REQUIRE_CREDIT=0)',
  };
}

/**
 * Warn (do not fail) when the credit ledger likely lives on ephemeral storage.
 *
 * Only relevant when credit gating is effectively ON: the JSON ledger holds
 * credit balances, consumed deposit tx hashes, and reservations. On hosts with
 * an ephemeral filesystem (e.g. Railway), a restart/redeploy wipes the file —
 * balances vanish and already-claimed deposits become claimable AGAIN. We flag
 * the two "didn't think about it" configurations: CREDIT_LEDGER_PATH unset
 * (ledger falls back to ./data) or pointing under the default ./data
 * directory.
 */
export function warnIfEphemeralLedgerPath(
  ledgerPath: string | undefined,
  requireCredit: boolean,
): void {
  if (!requireCredit) return;

  // Mirror ledger.ts: empty string falls through to the ./data default.
  const resolved = ledgerPath ? path.resolve(ledgerPath) : undefined;
  const defaultDataDir = path.resolve(process.cwd(), 'data');
  const likelyEphemeral =
    resolved === undefined ||
    resolved === defaultDataDir ||
    resolved.startsWith(defaultDataDir + path.sep);
  if (!likelyEphemeral) return;

  const where = resolved ?? '(unset — defaults to ./data/credit-ledger.json)';
  logger.warn('Credit ledger on likely-ephemeral storage', {
    creditLedgerPath: where,
    message:
      'CREDIT_LEDGER_PATH is unset or under the default ./data directory. On ' +
      'hosts with an ephemeral filesystem (e.g. Railway) a restart/redeploy ' +
      'WIPES the ledger: credit balances and reservations are lost, and ' +
      'consumed deposit records vanish so already-claimed deposits can be ' +
      're-claimed. Point CREDIT_LEDGER_PATH at a file on a mounted ' +
      'PERSISTENT VOLUME.',
  });
  console.warn(
    `[Relayer] ⚠️ WARNING: credit gating is ON but the credit ledger path ` +
      `${where} is likely on EPHEMERAL storage. A restart/redeploy wipes ` +
      'credit balances AND the consumed-deposit record, letting ' +
      'already-claimed deposits be re-claimed. Set CREDIT_LEDGER_PATH to a ' +
      'file on a mounted PERSISTENT VOLUME.',
  );
}

/**
 * Warn (do not fail) when CORS is left wide open.
 *
 * The '*' default is intentionally preserved so browser SDK clients keep
 * working out of the box, but operators should pin CORS_ORIGIN to the app
 * origin(s).
 */
export function warnIfPermissiveCors(origin: string): void {
  if (origin !== '*') return;
  logger.warn('Permissive CORS', {
    corsOrigin: origin,
    message:
      'CORS_ORIGIN is "*": ANY web origin can call this relayer. Set ' +
      'CORS_ORIGIN to your app origin(s) for production.',
  });
  console.warn(
    '[Relayer] ⚠️ WARNING: CORS_ORIGIN is "*" — any web origin can call ' +
      'this relayer. Set CORS_ORIGIN to your app origin(s) for production.',
  );
}
