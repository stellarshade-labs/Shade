import { Command } from 'commander';
import { recoverStealthPrivateKey, scanAnnouncements } from '@shade/crypto';
import {
  Keypair,
  TransactionBuilder,
  Contract,
  StrKey,
  nativeToScVal,
  Asset,
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  parseStroops,
  formatStroops,
  prepareWithRestore,
  getNetworkConfig,
  waitForTransaction,
  buildWithdrawMessage,
  RelayerPool,
  NoHealthyRelayerError,
  type NetworkName,
} from 'stellar-shade';
import {
  loadKeystoreOrExit,
  resolveKeystorePath,
} from '../utils/keystore.js';
import { assertNetwork } from '../utils/network.js';
import { resolveSecret } from '../utils/secrets.js';
import { resolveFundingAuth } from '../utils/funding.js';
import {
  collectRelay,
  resolveRelays,
  printNoHealthyRelayer,
} from '../utils/relay.js';
import { getContractAddress } from '../utils/config.js';
import { getContractBalance, getNonce } from '../utils/soroban.js';
import { fetchAnnouncements } from './scan.js';
import chalk from 'chalk';

interface MatchedAnnouncement {
  ephemeralPubKey: Uint8Array;
  stealthPubKey: Uint8Array;
  stealthAddress: string;
  token: string;
  amount: bigint;
}

async function findMatchingAnnouncement(
  stealthAddress: string,
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
): Promise<MatchedAnnouncement | null> {
  // Page over ALL announcements (shared with scan.ts) rather than a single
  // capped read, so a stealth payment past the first page is still found and
  // remains withdrawable — otherwise those funds look unrecoverable via the CLI
  // (PAGE-1 / fund-visibility fix).
  const announcements = await fetchAnnouncements(
    contractId,
    server,
    networkPassphrase,
  );

  const matches = scanAnnouncements(
    viewPrivKey,
    spendPubKey,
    announcements.map((a) => ({
      ephemeralPubKey: a.ephemeralPubKey,
      viewTag: a.viewTag,
      stealthAddress: a.stealthAddress,
    })),
  );

  for (const match of matches) {
    if (match && match.address === stealthAddress) {
      const ann = announcements.find((a) => a.stealthAddress === stealthAddress);
      if (ann) {
        return {
          ephemeralPubKey: ann.ephemeralPubKey,
          stealthPubKey: ann.stealthPubKey,
          stealthAddress: ann.stealthAddress,
          token: ann.token,
          amount: ann.amount,
        };
      }
    }
  }

  return null;
}

/**
 * Option surface of the pool-withdraw flow. Mirrors the `withdraw` command's
 * flags; `claim` builds one directly for its pool-delegation path.
 */
export interface RunPoolWithdrawOpts {
  /** Stealth address to withdraw from. */
  stealthAddress: string;
  /** Destination Stellar address. */
  destination: string;
  /** Validated network name (commands validate via `assertNetwork` first). */
  network: NetworkName;
  /** Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json). */
  keystore?: string;
  /** Keystore password (prompts on stderr if omitted for an encrypted keystore). */
  password?: string;
  /** Amount to withdraw as a decimal string (default: full balance). */
  amount?: string;
  /** Asset to withdraw (default: native XLM, or CODE:ISSUER). */
  asset?: string;
  /** Secret key of the account paying the Soroban fee. */
  feePayer?: string;
  /**
   * Relay URL(s) for fee-bumped submission — repeatable/comma-joined; falls
   * back to `SHADE_RELAYERS` when empty.
   */
  relay?: string | string[];
  /** App account to debit a credit-gated relayer fee against. */
  fundingAccount?: string;
  /** Secret controlling `fundingAccount` (signs the relayer challenge). */
  fundingSecret?: string;
  /** Show detailed output. */
  verbose?: boolean;
}

/**
 * The pool-withdraw action: recover the stealth key for an announced deposit,
 * sign the withdraw message, and submit (directly or via a relay).
 *
 * Exported so `claim` can delegate its pool path with a plain function call
 * instead of rebuilding an argv array and re-parsing the withdraw command
 * (CLI-CLAIM-DELEGATE). Exits the process on failure, like every CLI action.
 */
export async function runPoolWithdraw(options: RunPoolWithdrawOpts): Promise<void> {
  const { stealthAddress, destination, network } = options;
  try {
    const keystorePath = resolveKeystorePath(options.keystore);
    const keystore = await loadKeystoreOrExit(keystorePath, options.password);

    if (!keystore.viewPrivateKey || !keystore.spendPrivateKey) {
      console.error(chalk.red('Error: Missing private keys in keystore'));
      process.exit(1);
    }

    if (!StrKey.isValidEd25519PublicKey(stealthAddress)) {
      console.error(chalk.red('Error: Invalid stealth address'));
      process.exit(1);
    }

    if (!StrKey.isValidEd25519PublicKey(destination)) {
      console.error(chalk.red('Error: Invalid destination address'));
      process.exit(1);
    }

    const feePayer = await resolveSecret(
      options.feePayer,
      'SHADE_FEE_PAYER',
      chalk.white('Enter fee-payer secret (S...): '),
    );
    if (!feePayer) {
      console.error(chalk.red('Error: a fee-payer secret is required'));
      console.error(chalk.gray('  A funded account must pay the Soroban invocation fee'));
      console.error(chalk.gray('  Provide it via --fee-payer, the SHADE_FEE_PAYER env var, or the prompt'));
      console.error(chalk.gray('  Optionally add --relay <url> for the relayer to fee-bump'));
      process.exit(1);
    }

    const { server, networkPassphrase } = getNetworkConfig(network);

    const contractAddress = getContractAddress(network);

    // Resolve token
    let tokenAddress: string;
    if (!options.asset || options.asset === 'native' || options.asset === 'XLM') {
      tokenAddress = Asset.native().contractId(networkPassphrase);
    } else {
      const parts = options.asset.split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        console.error(chalk.red('Error: Invalid asset format. Use CODE:ISSUER'));
        process.exit(1);
      }
      tokenAddress = new Asset(parts[0], parts[1]).contractId(networkPassphrase);
    }

    const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
    const spendPrivKey = Buffer.from(keystore.spendPrivateKey, 'hex');
    const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

    // Find the matching announcement
    console.log(chalk.cyan('Finding announcement for stealth address...'));

    const matched = await findMatchingAnnouncement(
      stealthAddress,
      contractAddress,
      server,
      networkPassphrase,
      viewPrivKey,
      spendPubKey,
    );

    if (!matched) {
      console.error(chalk.red('Error: Could not find announcement for this stealth address'));
      process.exit(1);
    }

    // Recover stealth private key
    console.log(chalk.cyan('Recovering stealth private key...'));
    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      matched.ephemeralPubKey,
    );

    // Get contract balance
    const balance = await getContractBalance(
      contractAddress,
      matched.stealthPubKey,
      tokenAddress,
      server,
      networkPassphrase,
    );

    if (balance <= 0n) {
      console.error(chalk.yellow('Stealth address has no balance in the pool'));
      process.exit(0);
    }

    const displayBalance = formatStroops(balance);
    console.log(chalk.gray(`  Pool balance: ${displayBalance}`));

    // Determine withdraw amount (exact stroops; reject >7dp / non-numeric)
    let withdrawAmount = balance;
    if (options.amount) {
      try {
        withdrawAmount = parseStroops(options.amount);
      } catch (e) {
        console.error(chalk.red(`Error: ${(e as Error).message}`));
        process.exit(1);
      }
      if (withdrawAmount > balance) {
        console.error(chalk.red(`Error: Requested ${options.amount} but balance is ${displayBalance}`));
        process.exit(1);
      }
    }

    // Get nonce
    const currentNonce = await getNonce(
      contractAddress,
      matched.stealthPubKey,
      server,
      networkPassphrase,
    );
    const nonce = currentNonce + 1n;

    if (options.verbose) {
      console.log(chalk.gray(`  Token:  ${tokenAddress}`));
      console.log(chalk.gray(`  Nonce:  ${nonce}`));
      console.log(chalk.gray(`  Amount: ${withdrawAmount} (stroops)`));
    }

    // Build and sign the withdraw message
    console.log(chalk.cyan('Signing withdraw message...'));

    const messageHash = buildWithdrawMessage(
      matched.stealthPubKey,
      tokenAddress,
      withdrawAmount,
      destination,
      nonce,
      contractAddress,
      networkPassphrase,
    );

    const signature = stealthPrivKey.sign(messageHash);
    stealthPrivKey.zeroize();

    // Build Soroban transaction
    console.log(chalk.cyan('Building withdraw transaction...'));

    const feePayerKeypair = Keypair.fromSecret(feePayer);

    const contract = new Contract(contractAddress);
    const feePayerAccount = await server.getAccount(feePayerKeypair.publicKey());

    // Build the withdraw invocation from a given source account. Reused so the
    // restore branch can rebuild on a fresh sequence after the RestoreFootprint
    // consumes the fee payer's next seq (otherwise the withdraw collides →
    // txBAD_SEQ). The non-archived path builds it exactly once.
    const buildWithdrawTx = (
      source: StellarSdk.Account,
    ): StellarSdk.Transaction =>
      new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase,
      })
        .addOperation(
          contract.call(
            'withdraw',
            nativeToScVal(Buffer.from(matched.stealthPubKey)),
            new StellarSdk.Address(tokenAddress).toScVal(),
            nativeToScVal(withdrawAmount, { type: 'i128' }),
            new StellarSdk.Address(destination).toScVal(),
            nativeToScVal(nonce, { type: 'u64' }),
            nativeToScVal(Buffer.from(signature)),
          ),
        )
        .setTimeout(30)
        .build();

    const withdrawTx = buildWithdrawTx(feePayerAccount);

    // Sign the fee-payer leg of any Soroban tx (withdraw or restore).
    const signLeg = (tx: StellarSdk.Transaction): Promise<StellarSdk.Transaction> => {
      tx.sign(feePayerKeypair);
      return Promise.resolve(tx);
    };

    // Funding auth only matters on the relayed path (credit-gated relayers);
    // never prompt for it on a direct submission.
    const relays = resolveRelays(options.relay);
    const funding = relays
      ? await resolveFundingAuth({
          fundingAccount: options.fundingAccount,
          fundingSecret: options.fundingSecret,
        })
      : {};

    // Submit a signed tx, fee-bumped through the relayer when configured,
    // otherwise directly to the RPC. Returns the transaction hash.
    //
    // The relayed path goes through the SDK RelayerPool: one URL is a plain
    // pass-through (bare `.../relay` URLs included), a list is health-probed
    // and fails over on relayer faults (A3). Funding auth + the inner-tx-hash
    // binding thread into `/relay` — a bare `{xdr}` POST would make a
    // credit-gated relayer (the default) reject 401/402.
    const relayerPool = relays
      ? RelayerPool.from(relays, { network })
      : undefined;
    const submit = async (signed: StellarSdk.Transaction): Promise<string> => {
      if (relayerPool) {
        console.log(chalk.cyan('Submitting via relay...'));
        return relayerPool.withRelayer(
          async (client, url) => {
            if (options.verbose) console.log(chalk.gray(`  Relayer: ${url}`));
            const { txHash } = await client.relay(
              signed.toEnvelope().toXDR('base64'),
              {
                fundingAccount: funding.fundingAccount,
                networkPassphrase,
              },
            );
            return txHash;
          },
          {
            fundingAccount: funding.fundingAccount,
            fundingSigner: funding.fundingSigner,
            rpcServer: server,
          },
        );
      }
      console.log(chalk.cyan('Submitting transaction...'));
      const result = await server.sendTransaction(signed);
      if (result.status === 'ERROR') {
        throw new Error('Transaction submission failed');
      }
      if (result.status === 'PENDING') {
        await waitForTransaction(server, result.hash);
      }
      return result.hash;
    };

    // Restore an archived Balance/Nonce footprint before assembling the
    // withdraw (prepareTransaction alone ignores sim.restorePreamble).
    const prepared = await prepareWithRestore(
      withdrawTx,
      buildWithdrawTx,
      server,
      networkPassphrase,
      signLeg,
      submit,
      (msg) => console.log(chalk.yellow(msg)),
    );

    const signedWithdraw = await signLeg(prepared);
    const txHash = await submit(signedWithdraw);

    const displayWithdraw = formatStroops(withdrawAmount);
    console.log(chalk.green(`✓ Withdrawn ${displayWithdraw} to ${destination}`));
    console.log(chalk.gray(`  Tx hash: ${txHash}`));

  } catch (error: any) {
    if (error instanceof NoHealthyRelayerError) {
      printNoHealthyRelayer(error);
      process.exit(1);
    }
    console.error(chalk.red('Error withdrawing:'), error.message);
    if (options.verbose && error.stack) {
      console.error(chalk.gray(error.stack));
    }
    process.exit(1);
  }
}

export const withdrawCommand = new Command('withdraw')
  .description('Withdraw tokens from the stealth pool')
  .argument('<stealth-address>', 'Stealth address to withdraw from')
  .argument('<destination>', 'Destination Stellar address')
  .option('--network <network>', 'Network to use', 'testnet')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--amount <amount>', 'Amount to withdraw (default: full balance)')
  .option('--asset <asset>', 'Asset to withdraw (default: native XLM, or CODE:ISSUER)')
  .option('--fee-payer <secret>', 'Secret key of account paying the Soroban fee (or set SHADE_FEE_PAYER / prompt; flags leak into shell history)')
  .option('--relay <url>', 'Relayer URL(s) for fee-bumped submission — repeatable or comma-separated; falls back to SHADE_RELAYERS', collectRelay)
  .option('--funding-account <address>', 'App account to debit a credit-gated relayer fee against')
  .option('--funding-secret <secret>', 'Secret controlling the funding account, signs the relayer challenge (or set SHADE_FUNDING_SECRET / prompt; flags leak into shell history)')
  .option('--verbose', 'Show detailed output')
  .action(async (stealthAddress: string, destination: string, options) =>
    runPoolWithdraw({
      stealthAddress,
      destination,
      network: assertNetwork(options.network),
      keystore: options.keystore,
      password: options.password,
      amount: options.amount,
      asset: options.asset,
      feePayer: options.feePayer,
      relay: options.relay,
      fundingAccount: options.fundingAccount,
      fundingSecret: options.fundingSecret,
      verbose: options.verbose,
    }),
  );
