import { Command } from 'commander';
import { scanAnnouncements } from '@shade/crypto';
import {
  StealthClient,
  HorizonClient,
  NETWORKS,
  formatStroops,
  parseStroops,
  labelForToken,
  getNetworkConfig,
  type NetworkName,
  type StealthKeys,
  type HorizonClaimableBalance,
} from 'stellar-shade';
import { loadKeystoreOrExit, resolveKeystorePath } from '../utils/keystore.js';
import { assertNetwork } from '../utils/network.js';
import { resolveIndexer } from '../utils/indexer.js';
import {
  getContractAddress,
  loadHorizonCursor,
  saveHorizonCursor,
  loadHorizonPayments,
  saveHorizonPayments,
} from '../utils/config.js';
import { getContractBalance } from '../utils/soroban.js';
import { fetchAnnouncements } from './scan.js';
import Table from 'cli-table3';
import chalk from 'chalk';

/** One account-method balance row (live funds only). */
export interface AccountBalanceRow {
  /** The stealth address holding the funds. */
  stealthAddress: string;
  /** Raw token identifier: 'native' or "CODE:ISSUER". */
  token: string;
  /** Live amount in stroops. */
  stroops: bigint;
}

function isNativeToken(token: string): boolean {
  return !token || token === 'native' || token === 'XLM';
}

/**
 * Account-method balances with Horizon-cursor reuse.
 *
 * Previously `balance` re-walked the ENTIRE Horizon transaction history on
 * every invocation (multi-minute hangs on testnet). Instead: resume the scan
 * from the cursor `scan`/`balance` persisted, persist the newly advanced
 * cursor (and any newly discovered payments, so the shared cursor never skips
 * past an uncached payment), then UNION the fresh results with the cached
 * `PersistedPayment` rows re-checked for liveness — a Horizon account probe
 * per cached native row and a claimable-balances lookup per cached CB row,
 * the same checks the SDK's balance scan applies to fresh rows.
 *
 * Nothing is double-counted when a payment is found both ways (dedupe in the
 * spirit of the cache-merge key stealthAddress|txHash|claimableBalanceId):
 * - native rows report the LIVE account balance, so at most ONE row per
 *   stealth address is emitted no matter how many sends landed there or how
 *   many cache entries mention it;
 * - claimable balances are unique by id — one row per live balance id.
 */
export async function collectAccountBalances(
  network: NetworkName,
  keys: StealthKeys,
  indexerUrl?: string,
): Promise<AccountBalanceRow[]> {
  const client = new StealthClient({ network, methods: ['account'], indexerUrl });
  const cursor = loadHorizonCursor(network);
  const { payments, cursor: advanced } = await client.balanceWithCursor(keys, {
    cursor: { account: cursor },
  });

  // Persist newly discovered payments BEFORE advancing the shared cursor
  // (scan.ts maintains the same invariant): once the cursor moves past a
  // transaction, only the cache can surface that payment again.
  if (payments.length > 0) {
    saveHorizonPayments(
      network,
      payments.map((p) => ({
        stealthAddress: p.stealthAddress,
        ephemeralPubKey: p.ephemeralPubKey,
        token: p.token,
        asset: p.asset,
        claimableBalanceId: p.claimableBalanceId,
        amount: p.amount,
        amountStroops: p.amountStroops,
        txHash: p.txHash,
      })),
    );
  }
  if (advanced.account) {
    saveHorizonCursor(network, advanced.account);
  }

  const rows: AccountBalanceRow[] = [];
  // Stealth addresses with an emitted native row (native rows are live account
  // balances, so one row per address) and emitted claimable-balance ids.
  const seenNative = new Set<string>();
  const seenCbIds = new Set<string>();

  // Fresh rows are already liveness-checked by the SDK's balance path.
  for (const p of payments) {
    const stroops = BigInt(p.amountStroops);
    if (stroops <= 0n) continue;
    if (p.claimableBalanceId) {
      if (seenCbIds.has(p.claimableBalanceId)) continue;
      seenCbIds.add(p.claimableBalanceId);
    } else {
      if (seenNative.has(p.stealthAddress)) continue;
      seenNative.add(p.stealthAddress);
    }
    rows.push({
      stealthAddress: p.stealthAddress,
      token: p.token || 'native',
      stroops,
    });
  }

  // Union: cached payments behind the cursor, re-checked for liveness.
  const horizon = new HorizonClient(NETWORKS[network].horizonUrl);
  // One claimable-balances listing per address, however many CB rows share it.
  const cbsByAddress = new Map<string, HorizonClaimableBalance[]>();

  for (const cached of loadHorizonPayments(network)) {
    if (cached.claimableBalanceId) {
      if (seenCbIds.has(cached.claimableBalanceId)) continue;
      let cbs = cbsByAddress.get(cached.stealthAddress);
      if (!cbs) {
        cbs = await horizon.getClaimableBalances(cached.stealthAddress);
        cbsByAddress.set(cached.stealthAddress, cbs);
      }
      const live = cbs.find((cb) => cb.id === cached.claimableBalanceId);
      if (!live) continue; // Claimed (or otherwise gone) — no longer income.
      const stroops = parseStroops(live.amount);
      if (stroops <= 0n) continue;
      seenCbIds.add(cached.claimableBalanceId);
      rows.push({
        stealthAddress: cached.stealthAddress,
        token: cached.asset ?? cached.token,
        stroops,
      });
    } else if (isNativeToken(cached.token)) {
      if (seenNative.has(cached.stealthAddress)) continue;
      seenNative.add(cached.stealthAddress); // Probe an address at most once.
      const account = await horizon.getAccount(cached.stealthAddress);
      if (!account) continue; // Merged away — fully claimed.
      const nativeBal = account.balances.find((b) => b.asset_type === 'native');
      if (!nativeBal) continue;
      const stroops = parseStroops(nativeBal.balance);
      if (stroops <= 0n) continue; // Swept — nothing spendable left.
      rows.push({
        stealthAddress: cached.stealthAddress,
        token: 'native',
        stroops,
      });
    }
    // A non-native cached row without a claimable-balance id is a shape the
    // scanner never persists — skip it rather than misreport liveness.
  }

  return rows;
}

export const balanceCommand = new Command('balance')
  .description('Show total balance across all stealth payments')
  .option('--network <network>', 'Network to use', 'testnet')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password <password>', 'Keystore password (prompts on stderr if omitted for an encrypted keystore)')
  .option('--indexer <url>', 'Announcement indexer URL for fast account-method discovery — falls back to SHADE_INDEXER; Horizon remains the source of truth')
  .action(async (options) => {
    try {
      const network = assertNetwork(options.network);
      const keystorePath = resolveKeystorePath(options.keystore);
      const keystore = await loadKeystoreOrExit(keystorePath, options.password);

      if (!keystore.viewPrivateKey) {
        console.error(chalk.red('Error: No view private key in keystore'));
        process.exit(1);
      }

      const { server, networkPassphrase } = getNetworkConfig(network);

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

      // --- Account method (direct sends via Horizon; resumes from the
      // persisted cursor and unions with the cached payments re-checked for
      // liveness, instead of re-walking the whole transaction history) ---
      try {
        const keys: StealthKeys = {
          metaAddress: '',
          spendPubKey: keystore.spendPublicKey,
          spendPrivKey: keystore.spendPrivateKey ?? '',
          viewPubKey: keystore.viewPublicKey,
          viewPrivKey: keystore.viewPrivateKey,
        };
        const accountRows = await collectAccountBalances(
          network,
          keys,
          resolveIndexer(options.indexer),
        );
        for (const row of accountRows) {
          const label = labelForToken(row.token, networkPassphrase);
          const prev = tokenBalances.get(label) || 0n;
          tokenBalances.set(label, prev + row.stroops);
          table.push(['account', row.stealthAddress, label, formatStroops(row.stroops)]);
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
