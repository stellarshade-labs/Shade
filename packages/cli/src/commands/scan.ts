import { Command } from 'commander';
import { scanAnnouncements } from '@shade/crypto';
import {
  StealthClient,
  labelForToken,
  simulateReadOnly,
  NETWORKS,
  getNetworkConfig,
  type NetworkName,
  type StealthKeys,
} from '@shade/sdk';
import { StrKey, nativeToScVal } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { loadKeystoreOrExit, resolveKeystorePath } from '../utils/keystore.js';
import { assertNetwork } from '../utils/network.js';
import { getContractBalance } from '../utils/soroban.js';
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

/** Optional progress sink for `--verbose` (no-op when the flag is off). */
type VerboseLog = (msg: string) => void;

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
  network: NetworkName,
  keys: StealthKeys,
  fullRescan: boolean,
  log?: VerboseLog,
): Promise<AccountScanRow[]> {
  if (fullRescan) {
    clearHorizonCursor(network);
    clearHorizonPayments(network);
    log?.('  account: cursor and payment cache cleared (--full-rescan)');
  }
  const cursor = loadHorizonCursor(network);
  log?.(`  account: resuming from cursor ${cursor ?? '(none — start of history)'}`);

  const started = Date.now();
  const client = new StealthClient({ network, methods: ['account'] });
  const result = await client.scanWithCursor(keys, {
    methods: ['account'],
    cursor: { account: cursor },
  });
  log?.(
    `  account: found ${result.payments.length} payment(s) in ${Date.now() - started}ms`,
  );

  if (result.cursor.account) {
    saveHorizonCursor(network, result.cursor.account);
    log?.(`  account: cursor advanced to ${result.cursor.account}`);
  }

  const persisted: PersistedPayment[] = result.payments.map((p) => ({
    stealthAddress: p.stealthAddress,
    ephemeralPubKey: p.ephemeralPubKey,
    token: p.token,
    asset: p.asset,
    claimableBalanceId: p.claimableBalanceId,
    amount: p.amount,
    amountStroops: p.amountStroops,
    txHash: p.txHash,
  }));
  if (persisted.length > 0) {
    saveHorizonPayments(network, persisted);
  }

  const networkPassphrase = NETWORKS[network].networkPassphrase;
  return result.payments.map((p) => ({
    stealthAddress: p.stealthAddress,
    token: p.asset ?? labelForToken(p.token, networkPassphrase),
    amount: p.amount,
    txHash: p.txHash,
  }));
}

export interface Announcement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  stealthPubKey: Uint8Array;
  stealthAddress: string;
  token: string;
  amount: bigint;
  ledger: number;
}

const ANNOUNCEMENT_PAGE_SIZE = 200;

async function fetchAnnouncementCount(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string
): Promise<number> {
  const result = await simulateReadOnly(
    contractId,
    'get_announcement_count',
    [],
    server,
    networkPassphrase,
  );
  if (result === null || result === undefined) return 0;
  return Number(result as string | number);
}

async function fetchAnnouncementPage(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
  start: number,
  limit: number,
  sinceLedger: number | undefined,
  out: Announcement[]
): Promise<number> {
  const decoded = (await simulateReadOnly(
    contractId,
    'get_announcements',
    [
      nativeToScVal(start, { type: 'u64' }),
      nativeToScVal(limit, { type: 'u64' }),
    ],
    server,
    networkPassphrase,
  )) as any[] | null;

  if (!decoded || !Array.isArray(decoded)) {
    return 0;
  }
  for (const ann of decoded) {
    const ledger = Number(ann.sequence || 0);
    if (sinceLedger && ledger < sinceLedger) continue;

    const stealthPk = new Uint8Array(ann.stealth_pk);
    const stealthAddress = StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk));
    out.push({
      ephemeralPubKey: new Uint8Array(ann.ephemeral_pk),
      viewTag: ann.view_tag,
      stealthPubKey: stealthPk,
      stealthAddress,
      token: ann.token?.toString?.() || 'unknown',
      amount: BigInt(ann.amount || 0),
      ledger,
    });
  }
  return decoded.length;
}

/**
 * Fetch ALL pool announcements, paging over the full set rather than a single
 * capped read. A cheap `get_announcement_count` bounds the loop; pages of
 * `ANNOUNCEMENT_PAGE_SIZE` are accumulated until the offset reaches the total,
 * so announcements at index >= a single page are no longer silently dropped
 * (PAGE-1). Mirrors the SDK's `PoolAdapter.scan` paging.
 */
export async function fetchAnnouncements(
  contractId: string,
  server: StellarSdk.rpc.Server,
  networkPassphrase: string,
  sinceLedger?: number,
  log?: VerboseLog,
): Promise<Announcement[]> {
  const announcements: Announcement[] = [];

  try {
    const total = await fetchAnnouncementCount(
      contractId,
      server,
      networkPassphrase
    );
    log?.(`  pool: ${total} announcement(s) on-chain`);
    let offset = 0;
    while (offset < total) {
      const returned = await fetchAnnouncementPage(
        contractId,
        server,
        networkPassphrase,
        offset,
        ANNOUNCEMENT_PAGE_SIZE,
        sinceLedger,
        announcements
      );
      if (returned === 0) break;
      log?.(`  pool: fetched page at offset ${offset} (${returned} announcement(s))`);
      offset += returned;
    }
  } catch (error) {
    console.error(chalk.yellow('Warning: Could not fetch announcements from contract'));
  }

  return announcements;
}

export const scanCommand = new Command('scan')
  .description('Scan for stealth payments you received (pool + account methods)')
  .option('--network <network>', 'Network to use', 'testnet')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--since-ledger <ledger>', 'Only scan announcements since this ledger', parseInt)
  .option('--full-rescan', 'Reset the account-method Horizon cursor and rescan from genesis')
  .option('--verbose', 'Show detailed scan progress')
  .action(async (options) => {
    try {
      const network = assertNetwork(options.network);
      const keystorePath = resolveKeystorePath(options.keystore);
      const keystore = await loadKeystoreOrExit(keystorePath, options.password);

      if (!keystore.viewPrivateKey) {
        console.error(chalk.red('Error: No view private key in keystore'));
        process.exit(1);
      }

      const vlog: VerboseLog | undefined = options.verbose
        ? (msg) => console.log(chalk.gray(msg))
        : undefined;

      const { server, networkPassphrase } = getNetworkConfig(network);

      const table = new Table({
        head: ['Method', 'Stealth Address', 'Token', 'Balance'],
        colWidths: [10, 58, 20, 18],
      });
      let found = 0;

      const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
      const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

      // --- Pool method (Soroban announcements) ---
      console.log(chalk.cyan('Scanning pool announcements...'));
      const poolStarted = Date.now();
      const contractAddress = getContractAddress(network);
      const announcements = await fetchAnnouncements(
        contractAddress,
        server,
        networkPassphrase,
        options.sinceLedger,
        vlog,
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
      vlog?.(`  pool: phase finished in ${Date.now() - poolStarted}ms`);

      // --- Account method (Horizon direct sends) ---
      console.log(chalk.cyan('Scanning direct account sends via Horizon...'));
      const accountStarted = Date.now();
      const keys: StealthKeys = {
        metaAddress: '',
        spendPubKey: keystore.spendPublicKey,
        spendPrivKey: keystore.spendPrivateKey ?? '',
        viewPubKey: keystore.viewPublicKey,
        viewPrivKey: keystore.viewPrivateKey,
      };

      try {
        const accountRows = await scanAccountMethod(
          network,
          keys,
          !!options.fullRescan,
          vlog,
        );
        for (const row of accountRows) {
          table.push(['account', row.stealthAddress, row.token, row.amount.toFixed(7)]);
          found++;
        }
      } catch (e: any) {
        console.error(chalk.yellow(`Warning: account-method scan failed: ${e.message}`));
      }
      vlog?.(`  account: phase finished in ${Date.now() - accountStarted}ms`);

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
