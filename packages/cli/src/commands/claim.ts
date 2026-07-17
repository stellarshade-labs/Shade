import { Command } from 'commander';
import {
  StealthClient,
  parseStroops,
  formatStroops,
  numberToStroops,
  type StealthKeys,
  type Payment,
} from '@shade/sdk';
import { StrKey } from '@stellar/stellar-sdk';
import {
  loadKeystoreOrExit,
  resolveKeystorePath,
} from '../utils/keystore.js';
import { assertNetwork } from '../utils/network.js';
import { resolveSecret } from '../utils/secrets.js';
import { resolveFundingAuth } from '../utils/funding.js';
import { findHorizonPayment } from '../utils/config.js';
import { runPoolWithdraw } from './withdraw.js';
import chalk from 'chalk';

/**
 * Parse a partial-claim `--amount` through the same exact-stroops path `send`
 * and `withdraw` use: `parseStroops` rejects non-numeric input and amounts
 * with more than 7 decimal places up front, and the returned whole-unit number
 * is re-derived from the exact stroop count instead of `parseFloat`-ing
 * arbitrary input.
 *
 * The SDK's `ClaimOpts.amount` is a `number` that gets re-derived to stroops
 * internally (`numberToStroops`), so as a final guard the parsed value is
 * round-tripped here: any amount that would not survive that conversion
 * exactly (sub-microlumen values stringify exponentially; astronomically large
 * ones exceed float stroop precision) is rejected up front rather than
 * claiming a different amount than requested.
 *
 * @throws {Error} When the amount is not a non-negative decimal, has >7dp, or
 *   cannot be represented exactly as the SDK's numeric claim amount.
 */
export function parseClaimAmount(amount: string): number {
  const stroops = parseStroops(amount);
  const parsed = Number(formatStroops(stroops));
  let roundTrip: bigint | undefined;
  try {
    roundTrip = numberToStroops(parsed);
  } catch {
    roundTrip = undefined;
  }
  if (roundTrip !== stroops) {
    throw new Error(
      `Amount "${amount}" cannot be represented exactly as a numeric claim ` +
        'amount — adjust it (values below 0.000001 whole units lose exactness).',
    );
  }
  return parsed;
}

export const claimCommand = new Command('claim')
  .description('Claim a discovered stealth payment to a destination address')
  .argument('<stealth-address>', 'Stealth address holding the funds')
  .argument('<destination>', 'Destination Stellar address (G...)')
  .option('--network <network>', 'Network to use', 'testnet')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--merge', 'Sweep the whole account via AccountMerge (account method)')
  .option('--no-merge', 'Leave the stealth account open (partial payout)')
  .option('--relay <url>', 'Relayer URL for fee-bumped submission')
  .option('--sponsored', 'Use the relayer sponsor-claim pair (token claimable-balance claims)')
  .option('--funding-account <address>', 'App account to debit a credit-gated relayer fee against')
  .option('--funding-secret <secret>', 'Secret controlling the funding account, signs the relayer challenge (or set SHADE_FUNDING_SECRET / prompt; flags leak into shell history)')
  .option('--fee-payer <secret>', 'Secret key paying the pool-withdraw Soroban fee (or set SHADE_FEE_PAYER / prompt; flags leak into shell history)')
  .option('--asset <asset>', 'Asset to claim (pool method): native or CODE:ISSUER')
  .option('--amount <amount>', 'Partial claim amount (account method, with --no-merge)')
  .option('--verbose', 'Show detailed output')
  .action(async (stealthAddress: string, destination: string, options) => {
    try {
      const network = assertNetwork(options.network);

      if (!StrKey.isValidEd25519PublicKey(stealthAddress)) {
        console.error(chalk.red('Error: Invalid stealth address'));
        process.exit(1);
      }
      if (!StrKey.isValidEd25519PublicKey(destination)) {
        console.error(chalk.red('Error: Invalid destination address'));
        process.exit(1);
      }

      const keystorePath = resolveKeystorePath(options.keystore);

      // Resolve the payment from the persisted account-method scan cache. A miss
      // means either no scan has run OR the payment arrived via the pool.
      const cached = findHorizonPayment(network, stealthAddress);

      if (!cached) {
        console.log(
          chalk.gray(
            `No scanned payment for ${stealthAddress} — run 'shade scan' first ` +
              '(or it may be a pool deposit). Delegating to the pool withdraw path...',
          ),
        );
        // Pool withdraws need a fee-payer secret; resolve it once here so the
        // delegated withdraw does not re-prompt, and so env/prompt work too.
        const feePayer = await resolveSecret(
          options.feePayer,
          'SHADE_FEE_PAYER',
          chalk.white('Enter fee-payer secret (S...): '),
        );
        await runPoolWithdraw({
          stealthAddress,
          destination,
          network,
          relay: options.relay,
          feePayer,
          asset: options.asset,
          fundingAccount: options.fundingAccount,
          fundingSecret: options.fundingSecret,
          keystore: options.keystore,
          password: options.password,
          verbose: options.verbose,
        });
        return;
      }

      const keystore = await loadKeystoreOrExit(keystorePath, options.password);

      if (!keystore.viewPrivateKey || !keystore.spendPrivateKey) {
        console.error(chalk.red('Error: Missing private keys in keystore'));
        process.exit(1);
      }

      const keys: StealthKeys = {
        metaAddress: '',
        spendPubKey: keystore.spendPublicKey,
        spendPrivKey: keystore.spendPrivateKey,
        viewPubKey: keystore.viewPublicKey,
        viewPrivKey: keystore.viewPrivateKey,
      };

      const payment: Payment = {
        stealthAddress: cached.stealthAddress,
        ephemeralPubKey: cached.ephemeralPubKey,
        token: cached.token,
        asset: cached.asset,
        claimableBalanceId: cached.claimableBalanceId,
        amount: cached.amount,
        // Exact stroops from the scan cache (normalized on load for caches
        // written before the field existed) — required by the SDK Payment.
        amountStroops: cached.amountStroops,
        method: 'account',
        txHash: cached.txHash,
      };

      const client = new StealthClient({
        network,
        methods: ['account'],
        relayer: options.relay,
      });

      const isToken =
        !!payment.claimableBalanceId ||
        (payment.asset !== undefined &&
          payment.asset !== 'native' &&
          payment.asset !== 'XLM');

      console.log(
        chalk.cyan(
          isToken
            ? 'Claiming token claimable balance from stealth account...'
            : 'Claiming XLM from stealth account...',
        ),
      );

      // Partial-claim amount: exact-stroops parsing (rejects >7dp) like send.
      let claimAmount: number | undefined;
      if (options.amount !== undefined) {
        try {
          claimAmount = parseClaimAmount(options.amount);
        } catch (e) {
          console.error(chalk.red(`Error: ${(e as Error).message}`));
          process.exit(1);
        }
      }

      // Funding auth only matters on the relayed path (credit-gated relayers);
      // never prompt for it on a direct submission.
      const funding = options.relay
        ? await resolveFundingAuth({
            fundingAccount: options.fundingAccount,
            fundingSecret: options.fundingSecret,
          })
        : {};

      const receipt = await client.claim(payment, destination, {
        keys,
        merge: options.merge !== false,
        relay: options.relay,
        sponsored: options.sponsored,
        fundingAccount: funding.fundingAccount,
        fundingSigner: funding.fundingSigner,
        amount: claimAmount,
      });

      console.log(chalk.green(`\u2713 Claimed ${receipt.amount} to ${destination}`));
      console.log(chalk.gray(`  Tx hash: ${receipt.txHash}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error claiming:'), message);
      if (options.verbose && error instanceof Error && error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });
