import { Command } from 'commander';
import { scanAnnouncements } from '@stealth/crypto';
import { StealthClient, labelForToken, type StealthKeys } from '@stealth/sdk';
import { StrKey, Networks, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { loadKeystoreInteractive, resolveKeystorePath } from '../utils/keystore.js';
import {
  getContractAddress,
  loadHorizonCursor,
  saveHorizonCursor,
  clearHorizonCursor,
  saveHorizonPayments,
  clearHorizonPayments,
  type PersistedPayment,
} from '../utils/config.js';
import Table from 'cli-table3';
import chalk from 'chalk';

interface AccountScanRow {
  stealthAddress: string;
  token: string;
  amount: number;
  txHash?: string;
}

/**
 * Scan direct account-method sends via Horizon, resuming from (and persisting)
 * the saved cursor. Discovered payments are ALSO persisted to disk next to the
 * cursor so `claim` can later resolve them by stealth address — otherwise a
 * cursor-advanced scan would discard them and the payment would only be
 * recoverable via --full-rescan. Returns the matching rows for display.
 */
async function scanAccountMethod(
  network: 'local' | 'testnet',
  keys: StealthKeys,
  fullRescan: boolean,
): Promise<AccountScanRow[]> {
  if (fullRescan) {
    clearHorizonCursor(network);
    clearHorizonPayments(network);
  }
  const cursor = loadHorizonCursor(network);

  const client = new StealthClient({ network, methods: ['account'] });
  const result = await client.scanWithCursor(keys, {
    methods: ['account'],
    cursor: { account: cursor },
  });

  if (result.cursor.account) {
    saveHorizonCursor(network, result.cursor.account);
  }

  const persisted: PersistedPayment[] = result.payments.map((p) => ({
    stealthAddress: p.stealthAddress,
    ephemeralPubKey: p.ephemeralPubKey,
    token: p.token,
    asset: p.asset,
    claimableBalanceId: p.claimableBalanceId,
    amount: p.amount,
    txHash: p.txHash,
  }));
  if (persisted.length > 0) {
    saveHorizonPayments(network, persisted);
  }

  const networkPassphrase =
    network === 'local' ? Networks.STANDALONE : Networks.TESTNET;
  return result.payments.map((p) => ({
    stealthAddress: p.stealthAddress,
    token: p.asset ?? labelForToken(p.token, networkPassphrase),
    amount: p.amount,
    txHash: p.txHash,
  }));
}

interface Announcement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  stealthPubKey: Uint8Array;
  stealthAddress: string;
  token: string;
  amount: bigint;
  ledger: number;
}

function createSimulationTx(
  operation: StellarSdk.xdr.Operation,
  networkPassphrase: string
): StellarSdk.Transaction {
  return new StellarSdk.TransactionBuilder(
    new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
    { fee: '100', networkPassphrase }
  )
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

async function fetchAnnouncements(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
  sinceLedger?: number
): Promise<Announcement[]> {
  const contract = new Contract(contractId);
  const announcements: Announcement[] = [];

  try {
    const op = contract.call(
      'get_announcements',
      nativeToScVal(0, { type: 'u64' }),
      nativeToScVal(1000, { type: 'u64' })
    );
    const sim = await server.simulateTransaction(
      createSimulationTx(op, networkPassphrase)
    );

    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const result = sim.result?.retval;
      if (result) {
        const decoded = StellarSdk.scValToNative(result) as any[];
        for (const ann of decoded) {
          const ledger = Number(ann.sequence || 0);
          if (sinceLedger && ledger < sinceLedger) continue;

          const stealthPk = new Uint8Array(ann.stealth_pk);
          const stealthAddress = StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk));
          announcements.push({
            ephemeralPubKey: new Uint8Array(ann.ephemeral_pk),
            viewTag: ann.view_tag,
            stealthPubKey: stealthPk,
            stealthAddress,
            token: ann.token?.toString?.() || 'unknown',
            amount: BigInt(ann.amount || 0),
            ledger,
          });
        }
      }
    }
  } catch (error) {
    console.error(chalk.yellow('Warning: Could not fetch announcements from contract'));
  }

  return announcements;
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
    createSimulationTx(op, networkPassphrase)
  );

  if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
    return BigInt(StellarSdk.scValToNative(sim.result.retval));
  }
  return 0n;
}

export const scanCommand = new Command('scan')
  .description('Scan for stealth payments you received (pool + account methods)')
  .option('--network <network>', 'Network to use', 'local')
  .option('--keystore <path>', 'Keystore file path (defaults to $STEALTH_KEYSTORE or ~/.stealth-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--since-ledger <ledger>', 'Only scan announcements since this ledger', parseInt)
  .option('--full-rescan', 'Reset the account-method Horizon cursor and rescan from genesis')
  .option('--verbose', 'Show detailed scan progress')
  .action(async (options) => {
    try {
      const network = options.network as 'local' | 'testnet';
      const keystorePath = resolveKeystorePath(options.keystore);
      const keystore = await loadKeystoreInteractive(keystorePath, options.password).catch(() => {
        console.error(chalk.red('Error: Missing keystore'));
        console.error(chalk.gray("  Run 'stealth keygen' first to create keys"));
        process.exit(1);
      });

      if (!keystore.viewPrivateKey) {
        console.error(chalk.red('Error: No view private key in keystore'));
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

      const table = new Table({
        head: ['Method', 'Stealth Address', 'Token', 'Balance'],
        colWidths: [10, 58, 20, 18],
      });
      let found = 0;

      const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
      const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

      // --- Pool method (Soroban announcements) ---
      console.log(chalk.cyan('Scanning pool announcements...'));
      const contractAddress = getContractAddress(network);
      const announcements = await fetchAnnouncements(
        contractAddress,
        server,
        networkPassphrase,
        options.sinceLedger,
      );

      if (announcements.length > 0) {
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
          if (!match) continue;
          const ann = announcements.find((a) => a.stealthAddress === match.address);
          if (!ann) continue;

          const balance = await getContractBalance(
            contractAddress,
            ann.stealthPubKey,
            ann.token,
            server,
            networkPassphrase,
          );
          const displayBalance = (Number(balance) / 1e7).toFixed(7);
          const label = labelForToken(ann.token, networkPassphrase);
          table.push(['pool', match.address, label, displayBalance]);
          found++;
        }
      }

      // --- Account method (Horizon direct sends) ---
      console.log(chalk.cyan('Scanning direct account sends via Horizon...'));
      const keys: StealthKeys = {
        metaAddress: '',
        spendPubKey: keystore.spendPublicKey,
        spendPrivKey: keystore.spendPrivateKey ?? '',
        viewPubKey: keystore.viewPublicKey,
        viewPrivKey: keystore.viewPrivateKey,
      };

      try {
        const accountRows = await scanAccountMethod(network, keys, !!options.fullRescan);
        for (const row of accountRows) {
          table.push(['account', row.stealthAddress, row.token, row.amount.toFixed(7)]);
          found++;
        }
      } catch (e: any) {
        console.error(chalk.yellow(`Warning: account-method scan failed: ${e.message}`));
      }

      if (found === 0) {
        console.log(chalk.yellow('No stealth payments found for your keys'));
        return;
      }

      console.log(table.toString());
      console.log(chalk.gray(`Found ${found} stealth payment(s)`));

    } catch (error: any) {
      console.error(chalk.red('Error scanning:'), error.message);
      process.exit(1);
    }
  });
