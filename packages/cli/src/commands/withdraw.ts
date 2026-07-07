import { Command } from 'commander';
import { recoverStealthPrivateKey, scanAnnouncements, signWithStealthKey } from '@shade/crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Contract,
  StrKey,
  nativeToScVal,
  Asset,
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha256';
import { parseStroops, formatStroops } from '@shade/sdk';
import {
  loadKeystoreInteractive,
  resolveKeystorePath,
} from '../utils/keystore.js';
import { resolveSecret } from '../utils/secrets.js';
import { getContractAddress } from '../utils/config.js';
import chalk from 'chalk';

interface MatchedAnnouncement {
  ephemeralPubKey: Uint8Array;
  stealthPubKey: Uint8Array;
  stealthAddress: string;
  token: string;
  amount: bigint;
}

function createSimulationTx(
  operation: StellarSdk.xdr.Operation,
  networkPassphrase: string,
): StellarSdk.Transaction {
  return new TransactionBuilder(
    new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
    { fee: '100', networkPassphrase },
  )
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

function i128ToBigEndian(value: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  // i128 big-endian: high 64 bits then low 64 bits
  dv.setBigInt64(0, value >> 64n);
  dv.setBigUint64(8, value & 0xFFFFFFFFFFFFFFFFn);
  return buf;
}

function u64ToBigEndian(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, value);
  return buf;
}

/** Build the withdraw message hash — must be byte-identical to the contract's build_withdraw_message */
function buildWithdrawMessage(
  stealthPk: Uint8Array,
  tokenAddress: string,
  amount: bigint,
  destination: string,
  nonce: bigint,
  contractId: string,
  networkPassphrase: string,
): Uint8Array {
  // Format: SHA256(stealth_pk(32) || token_strkey(56) || amount_be(16) || dest_strkey(56)
  //                || nonce_be(8) || contract_strkey(56) || network_id(32))
  const tokenBytes = Buffer.from(tokenAddress, 'utf-8'); // 56 bytes StrKey
  const destBytes = Buffer.from(destination, 'utf-8');   // 56 bytes StrKey
  const contractBytes = Buffer.from(contractId, 'utf-8'); // 56 bytes StrKey

  if (tokenBytes.length !== 56) throw new Error(`Token address must be 56 bytes StrKey, got ${tokenBytes.length}`);
  if (destBytes.length !== 56) throw new Error(`Destination must be 56 bytes StrKey, got ${destBytes.length}`);
  if (contractBytes.length !== 56) throw new Error(`Contract address must be 56 bytes StrKey, got ${contractBytes.length}`);
  const amountBytes = i128ToBigEndian(amount);           // 16 bytes
  const nonceBytes = u64ToBigEndian(nonce);              // 8 bytes
  const networkId = sha256(Buffer.from(networkPassphrase, 'utf-8')); // 32 bytes

  const msg = new Uint8Array(32 + tokenBytes.length + 16 + destBytes.length + 8 + contractBytes.length + 32);
  let offset = 0;
  msg.set(stealthPk, offset); offset += 32;
  msg.set(tokenBytes, offset); offset += tokenBytes.length;
  msg.set(amountBytes, offset); offset += 16;
  msg.set(destBytes, offset); offset += destBytes.length;
  msg.set(nonceBytes, offset); offset += 8;
  msg.set(contractBytes, offset); offset += contractBytes.length;
  msg.set(networkId, offset);

  return sha256(msg);
}

async function findMatchingAnnouncement(
  stealthAddress: string,
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
): Promise<MatchedAnnouncement | null> {
  const contract = new Contract(contractId);

  const op = contract.call(
    'get_announcements',
    nativeToScVal(0, { type: 'u64' }),
    nativeToScVal(1000, { type: 'u64' }),
  );
  const sim = await server.simulateTransaction(
    createSimulationTx(op, networkPassphrase),
  );

  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    return null;
  }

  const decoded = StellarSdk.scValToNative(sim.result.retval) as any[];
  const announcements = decoded.map((ann) => {
    const stealthPk = new Uint8Array(ann.stealth_pk);
    return {
      ephemeralPubKey: new Uint8Array(ann.ephemeral_pk),
      viewTag: ann.view_tag as number,
      stealthPubKey: stealthPk,
      stealthAddr: StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk)),
      token: ann.token?.toString?.() || 'unknown',
      amount: BigInt(ann.amount || 0),
    };
  });

  const matches = scanAnnouncements(
    viewPrivKey,
    spendPubKey,
    announcements.map((a) => ({
      ephemeralPubKey: a.ephemeralPubKey,
      viewTag: a.viewTag,
      stealthAddress: a.stealthAddr,
    })),
  );

  for (const match of matches) {
    if (match.address === stealthAddress) {
      const ann = announcements.find((a) => a.stealthAddr === stealthAddress);
      if (ann) {
        return {
          ephemeralPubKey: ann.ephemeralPubKey,
          stealthPubKey: ann.stealthPubKey,
          stealthAddress: ann.stealthAddr,
          token: ann.token,
          amount: ann.amount,
        };
      }
    }
  }

  return null;
}

async function getNonce(
  contractId: string,
  stealthPk: Uint8Array,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const contract = new Contract(contractId);
  const op = contract.call('get_nonce', nativeToScVal(Buffer.from(stealthPk)));
  const sim = await server.simulateTransaction(
    createSimulationTx(op, networkPassphrase),
  );

  if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
    return BigInt(StellarSdk.scValToNative(sim.result.retval));
  }
  return 0n;
}

async function getContractBalance(
  contractId: string,
  stealthPk: Uint8Array,
  tokenAddress: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const contract = new Contract(contractId);
  const op = contract.call(
    'get_balance',
    nativeToScVal(Buffer.from(stealthPk)),
    new StellarSdk.Address(tokenAddress).toScVal(),
  );
  const sim = await server.simulateTransaction(
    createSimulationTx(op, networkPassphrase),
  );

  if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
    return BigInt(StellarSdk.scValToNative(sim.result.retval));
  }
  return 0n;
}

async function waitForTransaction(
  server: StellarSdk.rpc.Server,
  hash: string,
  verbose?: boolean,
): Promise<void> {
  let attempts = 0;
  while (attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const result = await server.getTransaction(hash);
      if (result.status === 'SUCCESS') return;
      if (result.status === 'FAILED') throw new Error('Transaction failed on-chain');
    } catch (e: any) {
      if (e.message === 'Transaction failed on-chain') throw e;
      if (verbose) console.log(chalk.gray(`  Polling: ${e.message}`));
    }
    attempts++;
  }
  if (verbose) console.log(chalk.yellow('  Transaction confirmation timed out'));
}

export const withdrawCommand = new Command('withdraw')
  .description('Withdraw tokens from the stealth pool')
  .argument('<stealth-address>', 'Stealth address to withdraw from')
  .argument('<destination>', 'Destination Stellar address')
  .option('--network <network>', 'Network to use', 'local')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--amount <amount>', 'Amount to withdraw (default: full balance)')
  .option('--asset <asset>', 'Asset to withdraw (default: native XLM, or CODE:ISSUER)')
  .option('--fee-payer <secret>', 'Secret key of account paying the Soroban fee (or set SHADE_FEE_PAYER / prompt; flags leak into shell history)')
  .option('--relay <url>', 'Relay URL for fee-bumped submission')
  .option('--verbose', 'Show detailed output')
  .action(async (stealthAddress: string, destination: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';
      const keystorePath = resolveKeystorePath(options.keystore);
      const keystore = await loadKeystoreInteractive(keystorePath, options.password).catch(() => {
        console.error(chalk.red('Error: Missing keystore'));
        console.error(chalk.gray("  Run 'shade keygen' first to create keys"));
        process.exit(1);
      });

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

      const networkPassphrase = network === 'local'
        ? Networks.STANDALONE
        : Networks.TESTNET;

      const rpcUrl = network === 'local'
        ? 'http://localhost:8000/soroban/rpc'
        : 'https://soroban-testnet.stellar.org';

      const server = new StellarSdk.rpc.Server(rpcUrl, {
        allowHttp: network === 'local',
      });

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

      const signature = signWithStealthKey(messageHash, stealthPrivKey);

      // Build Soroban transaction
      console.log(chalk.cyan('Building withdraw transaction...'));

      const feePayerKeypair = Keypair.fromSecret(feePayer);

      const contract = new Contract(contractAddress);
      const feePayerAccount = await server.getAccount(feePayerKeypair.publicKey());

      const withdrawTx = new TransactionBuilder(feePayerAccount, {
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

      const prepared = await server.prepareTransaction(withdrawTx);
      prepared.sign(feePayerKeypair);

      // Submit
      let txHash: string;

      if (options.relay) {
        console.log(chalk.cyan('Submitting via relay...'));
        const url = options.relay.endsWith('/relay') ? options.relay : `${options.relay}/relay`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ xdr: prepared.toEnvelope().toXDR('base64') }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(`Relay error: ${(err as any).error}`);
        }
        const data = (await res.json()) as any;
        txHash = data.txHash;
      } else {
        console.log(chalk.cyan('Submitting transaction...'));
        const result = await server.sendTransaction(prepared);
        if (result.status === 'ERROR') {
          throw new Error('Transaction submission failed');
        }
        if (result.status === 'PENDING') {
          await waitForTransaction(server, result.hash, options.verbose);
        }
        txHash = result.hash;
      }

      const displayWithdraw = formatStroops(withdrawAmount);
      console.log(chalk.green(`\u2713 Withdrawn ${displayWithdraw} to ${destination}`));
      console.log(chalk.gray(`  Tx hash: ${txHash}`));

    } catch (error: any) {
      console.error(chalk.red('Error withdrawing:'), error.message);
      if (options.verbose && error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });
