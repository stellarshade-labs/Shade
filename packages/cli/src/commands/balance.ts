import { Command } from 'commander';
import { scanAnnouncements } from '@stealth/crypto';
import { Horizon, StrKey, Networks } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { loadKeystore } from '../utils/keystore.js';
import { getContractAddress } from '../utils/config.js';
import chalk from 'chalk';

interface Announcement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  stealthAddress: string;
  encryptedAmount?: string;
  ledger: number;
}

async function fetchAllAnnouncements(
  contractId: string,
  network: 'local' | 'testnet'
): Promise<Announcement[]> {
  const rpcUrl = network === 'local'
    ? 'http://localhost:8000/soroban/rpc'
    : 'https://soroban-testnet.stellar.org';

  const server = new StellarSdk.rpc.Server(rpcUrl, {
    allowHttp: network === 'local',
  });
  const contract = new StellarSdk.Contract(contractId);

  const announcements: Announcement[] = [];

  try {
    const getLogs = contract.call(
      'get_announcements',
      StellarSdk.nativeToScVal(0, { type: 'u64' }),
      StellarSdk.nativeToScVal(1000, { type: 'u64' })
    );
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

    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const result = sim.result?.retval;
      if (result) {
        const decoded = StellarSdk.scValToNative(result) as any[];
        for (const ann of decoded) {
          const stealthPk = new Uint8Array(ann.stealth_pk);
          const stealthAddress = StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk));
          announcements.push({
            ephemeralPubKey: new Uint8Array(ann.ephemeral_pk),
            viewTag: ann.view_tag,
            stealthAddress,
            encryptedAmount: ann.encrypted_amount,
            ledger: Number(ann.sequence || 0)
          });
        }
      }
    }
  } catch (error) {
    console.error(chalk.yellow('Warning: Could not fetch announcements'));
  }

  return announcements;
}

async function getAccountBalance(
  address: string,
  network: 'local' | 'testnet'
): Promise<number> {
  const horizonUrl = network === 'local'
    ? 'http://localhost:8000'
    : 'https://horizon-testnet.stellar.org';

  const server = new Horizon.Server(horizonUrl, {
    allowHttp: network === 'local',
  });

  try {
    const account = await server.accounts().accountId(address).call();
    const xlmBalance = account.balances.find(b => b.asset_type === 'native');
    return parseFloat(xlmBalance?.balance || '0');
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return 0;
    }
    throw error;
  }
}

export const balanceCommand = new Command('balance')
  .description('Show total balance across all stealth addresses')
  .option('--network <network>', 'Network to use', 'local')
  .action(async (options) => {
    try {
      const network = options.network as 'local' | 'testnet';
      const keystore = await loadKeystore();

      if (!keystore.viewPrivateKey) {
        console.error(chalk.red('Error: No view private key in keystore'));
        process.exit(1);
      }

      console.log(chalk.cyan('Scanning for stealth addresses...'));

      const contractAddress = getContractAddress(network);
      const announcements = await fetchAllAnnouncements(contractAddress, network);

      if (announcements.length === 0) {
        console.log(chalk.yellow('No announcements found'));
        console.log(chalk.green('Total balance: 0 XLM'));
        return;
      }

      const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
      const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

      const stealthAddresses = scanAnnouncements(
        viewPrivKey,
        spendPubKey,
        announcements.map(a => ({
          ephemeralPubKey: a.ephemeralPubKey,
          viewTag: a.viewTag,
          stealthAddress: a.stealthAddress
        }))
      );

      if (stealthAddresses.length === 0) {
        console.log(chalk.yellow('No stealth addresses found for your keys'));
        console.log(chalk.green('Total balance: 0 XLM'));
        return;
      }

      console.log(chalk.gray(`Found ${stealthAddresses.length} stealth address(es)`));

      let totalBalance = 0;
      let addressCount = 0;

      for (const stealth of stealthAddresses) {
        const stellarAddress = stealth.address;
        const balance = await getAccountBalance(stellarAddress, network);

        if (balance > 0) {
          console.log(chalk.gray(`  ${stellarAddress}: ${balance.toFixed(7)} XLM`));
          addressCount++;
        }

        totalBalance += balance;
      }

      console.log(chalk.green(`\nTotal balance: ${totalBalance.toFixed(7)} XLM`));
      if (addressCount > 0) {
        console.log(chalk.gray(`Across ${addressCount} funded stealth address(es)`));
      }

    } catch (error: any) {
      console.error(chalk.red('Error checking balance:'), error.message);
      process.exit(1);
    }
  });