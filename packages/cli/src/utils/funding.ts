import { Keypair } from '@stellar/stellar-sdk';
import type { FundingSigner } from 'stellar-shade';
import { resolveSecret } from './secrets.js';
import chalk from 'chalk';

/** Resolved funding credentials for credit-gated relayer requests. */
export interface FundingAuth {
  /** App account (G-address) the relayer debits the fee against. */
  fundingAccount?: string;
  /** Signer proving control of `fundingAccount` (signs the challenge nonce). */
  fundingSigner?: FundingSigner;
}

/**
 * Resolve the funding account + proof-of-control signer for a credit-gated
 * relayer from `--funding-account` / `--funding-secret` (or the
 * `SHADE_FUNDING_SECRET` env var, or an stderr prompt — same precedence as
 * every other CLI secret).
 *
 * - Secret alone: the funding account is derived from it.
 * - Both: the secret must control the given account, or this throws — a typo'd
 *   pairing would otherwise sign challenges the relayer rejects.
 * - Account without a resolvable secret: prompt (funding auth is clearly
 *   intended — a credit-gated relayer rejects account-only requests). An empty
 *   entry falls back to account-only, which still works on non-gated relayers.
 * - Neither flag nor env: `{}` without ever prompting (funding is optional).
 */
export async function resolveFundingAuth(opts: {
  fundingAccount?: string;
  fundingSecret?: string;
}): Promise<FundingAuth> {
  if (
    !opts.fundingAccount &&
    !opts.fundingSecret &&
    !process.env.SHADE_FUNDING_SECRET
  ) {
    return {};
  }

  const secret = await resolveSecret(
    opts.fundingSecret,
    'SHADE_FUNDING_SECRET',
    chalk.white('Enter funding-account secret (S...): '),
  );
  if (!secret) {
    return { fundingAccount: opts.fundingAccount };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    throw new Error('Invalid funding secret — expected an S... secret key');
  }
  if (opts.fundingAccount && keypair.publicKey() !== opts.fundingAccount) {
    throw new Error(
      `The funding secret controls ${keypair.publicKey()}, not the given ` +
        `--funding-account ${opts.fundingAccount}`,
    );
  }

  return {
    fundingAccount: opts.fundingAccount ?? keypair.publicKey(),
    fundingSigner: (message) => keypair.sign(Buffer.from(message)),
  };
}
