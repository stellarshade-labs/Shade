import { Command } from 'commander';
import { scanAnnouncements } from '@stealth/crypto';
import { StealthClient, type StealthKeys } from '@stealth/sdk';
import { StrKey, Networks, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { loadKeystore } from '../utils/keystore.js';
import { getContractAddress } from '../utils/config.js';
import Table from 'cli-table3';
import chalk from 'chalk';

interface Announcement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  stealthPubKey: Uint8Array;
  stealthAddress: string;
  token: string;
  amount: bigint;
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

async function fetchAllAnnouncements(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
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
          const stealthPk = new Uint8Array(ann.stealth_pk);
          const stealthAddress = StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk));
          announcements.push({
            ephemeralPubKey: new Uint8Array(ann.ephemeral_pk),
            viewTag: ann.view_tag,
            stealthPubKey: stealthPk,
            stealthAddress,
            token: ann.token?.toString?.() || 'unknown',
            amount: BigInt(ann.amount || 0),
          });
        }
      }
    }
  } catch (error) {
    console.error(chalk.yellow('Warning: Could not fetch announcements'));
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

export const balanceCommand = new Command('balance')
  .description('Show total balance across all stealth payments')
  .option('--network <network>', 'Network to use', 'local')
  .action(async (options) => {
    try {
      const network = options.network as 'local' | 'testnet';
      const keystore = await loadKeystore();

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

      // --- Pool method ---
      const announcements = await fetchAllAnnouncements(
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
            const prev = tokenBalances.get(ann.token) || 0n;
            tokenBalances.set(ann.token, prev + balance);
            const displayBalance = (Number(balance) / 1e7).toFixed(7);
            table.push(['pool', match.address, ann.token, displayBalance]);
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
        const accountPayments = await client.scan(keys);
        for (const p of accountPayments) {
          if (p.amount <= 0) continue;
          const stroops = BigInt(Math.round(p.amount * 1e7));
          const prev = tokenBalances.get('native') || 0n;
          tokenBalances.set('native', prev + stroops);
          table.push(['account', p.stealthAddress, 'native', p.amount.toFixed(7)]);
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
