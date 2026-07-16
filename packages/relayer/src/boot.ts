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
