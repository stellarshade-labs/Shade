import { Command } from 'commander';
import { scanAnnouncements } from '@stealth/crypto';
import { Horizon, StrKey, Networks } from '@stellar/stellar-sdk';
import { loadKeystore } from '../utils/keystore.js';
import { getContractAddress } from '../utils/config.js';
import { withRetry, formatError } from '../utils/network.js';
import Table from 'cli-table3';
import chalk from 'chalk';
import * as StellarSdk from '@stellar/stellar-sdk';

interface Announcement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  encryptedAmount?: string;
  ledger: number;
}

async function fetchAnnouncements(
  contractId: string,
  network: 'local' | 'testnet',
  sinceLedger?: number
): Promise<Announcement[]> {
  const rpcUrl = network === 'local'
    ? 'http://localhost:8000/soroban/rpc'
    : 'https://soroban-testnet.stellar.org';

  const server = new StellarSdk.SorobanRpc.Server(rpcUrl);
  const contract = new StellarSdk.Contract(contractId);

  const announcements: Announcement[] = [];

  try {
    const getLogs = contract.call('get_announcements');
    const sim = await server.simulateTransaction(
      new StellarSdk.TransactionBuilder(
        new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
        {
          fee: '100',
          networkPassphrase: network === 'local'
            ? Networks.STANDALONE
            : Networks.TESTNET
        }
      )
      .addOperation(getLogs)
      .setTimeout(30)
      .build()
    );

    if (StellarSdk.SorobanRpc.Api.isSimulationSuccess(sim)) {
      const result = sim.result?.retval;
      if (result) {
        const decoded = StellarSdk.scValToNative(result) as any[];
        for (const ann of decoded) {
          const ledger = Number(ann.ledger || 0);
          if (sinceLedger && ledger < sinceLedger) continue;

          announcements.push({
            ephemeralPubKey: new Uint8Array(ann.ephemeral_pub_key),
            viewTag: ann.view_tag,
            encryptedAmount: ann.encrypted_amount,
            ledger
          });
        }
      }
    }
  } catch (error) {
    console.error(chalk.yellow('Warning: Could not fetch announcements from contract'));
  }

  return announcements;
}

async function getAccountBalance(
  address: string,
  network: 'local' | 'testnet'
): Promise<string> {
  const horizonUrl = network === 'local'
    ? 'http://localhost:8000'
    : 'https://horizon-testnet.stellar.org';

  const server = new Horizon.Server(horizonUrl);

  try {
    const account = await server.accounts().accountId(address).call();
    const xlmBalance = account.balances.find(b => b.asset_type === 'native');
    return xlmBalance?.balance || '0';
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return '0';
    }
    throw error;
  }
}

export const scanCommand = new Command('scan')
  .description('Scan for stealth addresses you own')
  .option('--network <network>', 'Network to use', 'local')
  .option('--since-ledger <ledger>', 'Only scan announcements since this ledger', parseInt)
  .option('--verbose', 'Show detailed scan progress')
  .action(async (options) => {
    try {
      const network = options.network as 'local' | 'testnet';
      const keystore = await loadKeystore().catch(() => {
        console.error(chalk.red('Error: Missing keystore'));
        console.error(chalk.gray("  Run 'stealth keygen' first to create keys"));
        process.exit(1);
      });

      if (!keystore.viewPrivateKey) {
        console.error(chalk.red('Error: No view private key in keystore'));
        process.exit(1);
      }

      console.log(chalk.cyan('Scanning for stealth addresses...'));

      const contractAddress = getContractAddress(network);
      const announcements = await fetchAnnouncements(
        contractAddress,
        network,
        options.sinceLedger
      );

      if (announcements.length === 0) {
        console.log(chalk.yellow('No announcements found'));
        return;
      }

      console.log(chalk.gray(`Found ${announcements.length} announcements`));

      const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
      const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

      const stealthAddresses = scanAnnouncements(
        viewPrivKey,
        spendPubKey,
        announcements.map(a => ({
          ephemeralPubKey: a.ephemeralPubKey,
          viewTag: a.viewTag,
          encryptedAmount: a.encryptedAmount
        }))
      );

      if (stealthAddresses.length === 0) {
        console.log(chalk.yellow('No stealth addresses found for your keys'));
        return;
      }

      const table = new Table({
        head: ['Stealth Address', 'Balance (XLM)', 'Discovered at Ledger'],
        colWidths: [58, 15, 22]
      });

      let totalBalance = 0;

      for (let i = 0; i < stealthAddresses.length; i++) {
        const stealth = stealthAddresses[i];
        const announcement = announcements.find(
          a => Buffer.from(a.ephemeralPubKey).equals(Buffer.from(stealth.ephemeralPubKey))
        );

        const stellarAddress = StrKey.encodeEd25519PublicKey(stealth.stealthPubKey);
        const balance = await getAccountBalance(stellarAddress, network);
        totalBalance += parseFloat(balance);

        table.push([
          stellarAddress,
          balance,
          announcement?.ledger || 'Unknown'
        ]);
      }

      console.log(table.toString());
      console.log(chalk.green(`\nTotal balance: ${totalBalance.toFixed(7)} XLM`));
      console.log(chalk.gray(`Found ${stealthAddresses.length} stealth address(es)`));

    } catch (error: any) {
      console.error(chalk.red('Error scanning:'), error.message);
      process.exit(1);
    }
  });