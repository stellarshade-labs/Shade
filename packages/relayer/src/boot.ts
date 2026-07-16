import path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { logger } from './utils/logger.js';

/**
 * Resolve the relayer's signing keypair from RELAYER_SECRET.
 *
 * On non-local networks (testnet/mainnet) a configured, funded secret is
 * mandatory: a randomly generated keypair is unfunded, so the relayer would
 * boot "successfully" but be unable to pay a single fee — every relay/sponsor
 * request would silently fail. Fail fast (exit 1) instead of limping along.
 * The random-keypair convenience is kept ONLY for `network === 'local'`.
 */
export function resolveRelayerKeypair(
  secret: string | undefined,
  network: string,
): Keypair {
  if (secret) {
    const keypair = Keypair.fromSecret(secret);
    logger.info('Using configured keypair', { publicKey: keypair.publicKey() });
    return keypair;
  }

  if (network !== 'local') {
    logger.error('RELAYER_SECRET is required on non-local networks', {
      network,
      message:
        'Refusing to start: a randomly generated keypair is unfunded and can ' +
        'never pay fees. Set RELAYER_SECRET to the secret key (S...) of a ' +
        'funded account and restart.',
    });
    console.error(
      `[Relayer] FATAL: RELAYER_SECRET is not set and NETWORK=${network}. ` +
        'A funded relayer secret is required on testnet/mainnet — a random ' +
        'keypair cannot pay fees. Set RELAYER_SECRET and restart.',
    );
    process.exit(1);
  }

  const keypair = Keypair.random();
  logger.warn('Generated new keypair', {
    publicKey: keypair.publicKey(),
    message: 'Set RELAYER_SECRET env var to persist this keypair',
  });
  return keypair;
}

/** How the effective credit-gating value was resolved, for the startup log. */
export interface RequireCreditResolution {
  requireCredit: boolean;
  /** Human-readable WHY, e.g. "default for non-local network". */
  reason: string;
}

/**
 * Resolve whether credit gating is required (secure-by-default).
 *
 * When RELAYER_REQUIRE_CREDIT is set it always wins ('1' = on, anything else
 * = off). When it is UNSET, the default is network-aware: credit is REQUIRED
 * on non-local networks (testnet/mainnet) so an unconfigured deploy cannot be
 * drained through unauthenticated /relay and /sponsor-claim/submit calls, and
 * OFF on `local` for dev convenience.
 */
export function resolveRequireCredit(
  raw: string | undefined,
  network: string,
): RequireCreditResolution {
  if (raw !== undefined) {
    return {
      requireCredit: raw === '1',
      reason: `RELAYER_REQUIRE_CREDIT=${raw} set explicitly`,
    };
  }
  const requireCredit = network !== 'local';
  return {
    requireCredit,
    reason: requireCredit
      ? 'default for non-local network'
      : 'default for local network',
  };
}

/**
 * Warn (do not fail) when the credit ledger likely lives on ephemeral storage.
 *
 * Only relevant when credit gating is effectively ON on a non-local network:
 * the JSON ledger holds credit balances, consumed deposit tx hashes, and
 * reservations. On hosts with an ephemeral filesystem (e.g. Railway), a
 * restart/redeploy wipes the file — balances vanish and already-claimed
 * deposits become claimable AGAIN. We flag the two "didn't think about it"
 * configurations: CREDIT_LEDGER_PATH unset (ledger falls back to ./data) or
 * pointing under the default ./data directory.
 */
export function warnIfEphemeralLedgerPath(
  ledgerPath: string | undefined,
  requireCredit: boolean,
  network: string,
): void {
  if (!requireCredit || network === 'local') return;

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
    network,
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
    `[Relayer] ⚠️ WARNING: credit gating is ON (NETWORK=${network}) but the ` +
      `credit ledger path ${where} is likely on EPHEMERAL storage. A ` +
      'restart/redeploy wipes credit balances AND the consumed-deposit ' +
      'record, letting already-claimed deposits be re-claimed. Set ' +
      'CREDIT_LEDGER_PATH to a file on a mounted PERSISTENT VOLUME.',
  );
}

/**
 * Warn (do not fail) when CORS is left wide open on a non-local network.
 *
 * The '*' default is intentionally preserved so browser SDK clients keep
 * working out of the box, but on testnet/mainnet operators should pin
 * CORS_ORIGIN to the app origin(s).
 */
export function warnIfPermissiveCors(origin: string, network: string): void {
  if (origin !== '*' || network === 'local') return;
  logger.warn('Permissive CORS on non-local network', {
    network,
    corsOrigin: origin,
    message:
      'CORS_ORIGIN is "*": ANY web origin can call this relayer. Set ' +
      'CORS_ORIGIN to your app origin(s) for production.',
  });
  console.warn(
    `[Relayer] ⚠️ WARNING: CORS_ORIGIN is "*" on NETWORK=${network} — any web ` +
      'origin can call this relayer. Set CORS_ORIGIN to your app origin(s) ' +
      'for production.',
  );
}
