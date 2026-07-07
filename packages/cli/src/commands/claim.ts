import { Command } from 'commander';
import { StealthClient, type StealthKeys, type Payment } from '@stealth/sdk';
import { StrKey } from '@stellar/stellar-sdk';
import {
  loadKeystoreInteractive,
  resolveKeystorePath,
} from '../utils/keystore.js';
import { resolveSecret } from '../utils/secrets.js';
import { findHorizonPayment } from '../utils/config.js';
import { withdrawCommand } from './withdraw.js';
import chalk from 'chalk';

/**
 * Delegate a pool-method claim to the existing `withdraw` flow. A stealth
 * address with no discovered account-method payment is assumed to be a pool
 * deposit — the withdraw command re-derives the announcement, recovers the
 * stealth key, and submits the ed25519-signed pool withdrawal.
 */
async function claimViaPool(
  stealthAddress: string,
  destination: string,
  options: {
    network: string;
    relay?: string;
    feePayer?: string;
    asset?: string;
    keystore?: string;
    password?: string;
    verbose?: boolean;
  },
): Promise<void> {
  const argv = [
    'node',
    'stealth',
    stealthAddress,
    destination,
    '--network',
    options.network,
  ];
  if (options.asset) argv.push('--asset', options.asset);
  if (options.feePayer) argv.push('--fee-payer', options.feePayer);
  if (options.relay) argv.push('--relay', options.relay);
  if (options.keystore) argv.push('--keystore', options.keystore);
  if (options.password !== undefined) argv.push('--password', options.password);
  if (options.verbose) argv.push('--verbose');
  await withdrawCommand.parseAsync(argv);
}

export const claimCommand = new Command('claim')
  .description('Claim a discovered stealth payment to a destination address')
  .argument('<stealth-address>', 'Stealth address holding the funds')
  .argument('<destination>', 'Destination Stellar address (G...)')
  .option('--network <network>', 'Network to use', 'local')
  .option('--keystore <path>', 'Keystore file path (defaults to $STEALTH_KEYSTORE or ~/.stealth-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--merge', 'Sweep the whole account via AccountMerge (account method)')
  .option('--no-merge', 'Leave the stealth account open (partial payout)')
  .option('--relay <url>', 'Relayer URL for fee-bumped submission')
  .option('--sponsored', 'Use the relayer sponsor-claim pair (token claimable-balance claims)')
  .option('--funding-account <address>', 'App account to debit a credit-gated relayer fee against')
  .option('--fee-payer <secret>', 'Secret key paying the pool-withdraw Soroban fee (or set STEALTH_FEE_PAYER / prompt; flags leak into shell history)')
  .option('--asset <asset>', 'Asset to claim (pool method): native or CODE:ISSUER')
  .option('--amount <amount>', 'Partial claim amount (account method, with --no-merge)')
  .option('--verbose', 'Show detailed output')
  .action(async (stealthAddress: string, destination: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';

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
            `No scanned payment for ${stealthAddress} — run 'stealth scan' first ` +
              '(or it may be a pool deposit). Delegating to the pool withdraw path...',
          ),
        );
        // Pool withdraws need a fee-payer secret; resolve it once here so the
        // delegated withdraw does not re-prompt, and so env/prompt work too.
        const feePayer = await resolveSecret(
          options.feePayer,
          'STEALTH_FEE_PAYER',
          chalk.white('Enter fee-payer secret (S...): '),
        );
        await claimViaPool(stealthAddress, destination, {
          network,
          relay: options.relay,
          feePayer,
          asset: options.asset,
          keystore: options.keystore,
          password: options.password,
          verbose: options.verbose,
        });
        return;
      }

      const keystore = await loadKeystoreInteractive(keystorePath, options.password).catch(() => {
        console.error(chalk.red('Error: Missing keystore'));
        console.error(chalk.gray("  Run 'stealth keygen' first to create keys"));
        process.exit(1);
      });

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

      const receipt = await client.claim(payment, destination, {
        keys,
        merge: options.merge !== false,
        relay: options.relay,
        sponsored: options.sponsored,
        fundingAccount: options.fundingAccount,
        amount: options.amount ? parseFloat(options.amount) : undefined,
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
