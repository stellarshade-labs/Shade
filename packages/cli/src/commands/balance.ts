import { Command } from 'commander';
import { scanAnnouncements } from '@shade/crypto';
import {
  StealthClient,
  formatStroops,
  numberToStroops,
  labelForToken,
  type StealthKeys,
} from '@shade/sdk';
import { Networks, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { loadKeystoreOrExit, resolveKeystorePath } from '../utils/keystore.js';
import { assertNetwork } from '../utils/network.js';
import { getContractAddress } from '../utils/config.js';
import { fetchAnnouncements } from './scan.js';
import Table from 'cli-table3';
import chalk from 'chalk';

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

export const balanceCommand = new Command('balance')
  .description('Show total balance across all stealth payments')
  .option('--network <network>', 'Network to use', 'local')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .action(async (options) => {
    try {
      const network = assertNetwork(options.network);
      const keystorePath = resolveKeystorePath(options.keystore);
      const keystore = await loadKeystoreOrExit(keystorePath, options.password);

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

      console.log(chalk.cyan('Scanning for stealth payments...'));

      const contractAddress = getContractAddress(network);

      // Group balances by token (in stroops)
      const tokenBalances = new Map<string, bigint>();

      const table = new Table({
        head: ['Method', 'Stealth Address', 'Token', 'Balance'],
        colWidths: [10, 58, 20, 18],
      });

      const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
      const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

      // --- Pool method (fully paged; reuses scan.ts fetchAnnouncements so a
      // payment past the first page is not silently dropped — PAGE-1 fix) ---
      const announcements = await fetchAnnouncements(
        contractAddress,
        server,
        networkPassphrase,
      );

      if (announcements.length > 0) {
        const matches = scanAnnouncements(
          viewPrivKey,
          spendPubKey,
          announcements.map(a => ({
            ephemeralPubKey: a.ephemeralPubKey,
            viewTag: a.viewTag,
            stealthAddress: a.stealthAddress,
          }))
        );

        for (const match of matches) {
          if (!match) continue;
          const ann = announcements.find(a => a.stealthAddress === match.address);
          if (!ann) continue;

          const balance = await getContractBalance(
            contractAddress,
            ann.stealthPubKey,
            ann.token,
            server,
            networkPassphrase,
          );

          if (balance > 0n) {
            const label = labelForToken(ann.token, networkPassphrase);
            const prev = tokenBalances.get(label) || 0n;
            tokenBalances.set(label, prev + balance);
            const displayBalance = formatStroops(balance);
            table.push(['pool', match.address, label, displayBalance]);
          }
        }
      }

      // --- Account method (direct XLM sends via Horizon) ---
      try {
        const keys: StealthKeys = {
          metaAddress: '',
          spendPubKey: keystore.spendPublicKey,
          spendPrivKey: keystore.spendPrivateKey ?? '',
          viewPubKey: keystore.viewPublicKey,
          viewPrivKey: keystore.viewPrivateKey,
        };
        const client = new StealthClient({ network, methods: ['account'] });
        const accountPayments = await client.balance(keys);
        for (const p of accountPayments) {
          const stroops = p.amountStroops
            ? BigInt(p.amountStroops)
            : numberToStroops(p.amount);
          if (stroops <= 0n) continue;
          const label = labelForToken(p.token || 'native', networkPassphrase);
          const prev = tokenBalances.get(label) || 0n;
          tokenBalances.set(label, prev + stroops);
          table.push(['account', p.stealthAddress, label, formatStroops(stroops)]);
        }
      } catch (e: any) {
        console.error(chalk.yellow(`Warning: account-method balance scan failed: ${e.message}`));
      }

      if (tokenBalances.size === 0) {
        console.log(chalk.yellow('All stealth balances are zero'));
        return;
      }

      console.log(table.toString());

      console.log(chalk.green('\nTotal balances:'));
      for (const [token, total] of tokenBalances) {
        const display = (Number(total) / 1e7).toFixed(7);
        console.log(chalk.green(`  ${token}: ${display}`));
      }

    } catch (error: any) {
      console.error(chalk.red('Error checking balance:'), error.message);
      process.exit(1);
    }
  });
