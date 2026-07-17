import type { HorizonFeed } from './horizon.js';
import type { AnnouncementRecord, AnnouncementStore } from './store/types.js';

/** Horizon's maximum (and our fixed) transaction page size. */
const PAGE_LIMIT = 200;

/**
 * Reset-suspicion tolerance in ledgers (~one checkpoint). A cursor slightly
 * ahead of `history_latest_ledger` is normal behind a load balancer serving
 * slightly-stale Horizon snapshots; only a cursor MORE than this far ahead
 * means the network was reset under a stale database.
 */
const RESET_TOLERANCE_LEDGERS = 64;

/**
 * Ledger sequence of a Horizon paging_token: a paging_token is a decimal
 * int64 TOID whose upper 32 bits are the ledger sequence. Exported for tests.
 */
export function ledgerOfToken(token: string): number {
  return Number(BigInt(token) >> 32n);
}

/** The logging surface the ingester needs (the package logger satisfies it). */
export interface IngestLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * Consecutive continuity-check intervals without a successful check before
 * the ingester reports `continuityStale` (and /health degrades): the check
 * failing once is a Horizon hiccup, failing for this long means gap/reset
 * detection has been effectively disabled and clients must stop trusting
 * coverage.
 */
const CONTINUITY_STALE_AFTER_CHECKS = 3;
/**
 * Floor for the continuity-staleness threshold regardless of a short
 * GAP_CHECK_INTERVAL_MS — the flag must describe a persistently failing
 * check, not the normal wait between two scheduled ones.
 */
const CONTINUITY_STALE_MIN_MS = 120_000;

/** Floor for the ingest-stall detector regardless of a short poll interval. */
const STALL_MIN_MS = 120_000;
/** Poll intervals without any successful tick before `stalled` reports true. */
const STALL_AFTER_INTERVALS = 5;

export interface IngesterStatus {
  lastPollAt: string | null;
  lastError: string | null;
  caughtUp: boolean;
  /**
   * True once the ingest cursor has been observed impossibly far past
   * Horizon's latest ledger on two consecutive continuity checks — the
   * signature of a testnet reset under a stale database. LATCHED: a stale-era
   * database never becomes trustworthy again just because the new chain grows
   * past the old cursor height, so the flag clears only on restart (after a
   * wipe, or after fixing a wrong HORIZON_URL).
   */
  resetSuspected: boolean;
  /** ISO time of the last FULLY successful continuity check, null before one. */
  lastContinuityOkAt: string | null;
  /**
   * True while continuity checking is not working: no successful check yet
   * this process, or none within {@link CONTINUITY_STALE_AFTER_CHECKS}
   * intervals. While true the gap/reset promises do not hold, so /health
   * reports 'degraded'.
   */
  continuityStale: boolean;
  /**
   * True when no ingest tick has completed successfully for
   * {@link STALL_AFTER_INTERVALS} poll intervals (min {@link STALL_MIN_MS}):
   * the deliberate stall of the feed-order assertion, or a persistently
   * failing Horizon. Surfaced so a frozen-but-reachable indexer degrades
   * /health instead of reporting 'ok' forever.
   */
  stalled: boolean;
}

export interface Ingester {
  start(startCursorSpec: string): Promise<void>;
  stop(): void;
  status(): IngesterStatus;
}

export interface IngesterOptions {
  horizon: HorizonFeed;
  store: AnnouncementStore;
  intervalMs: number;
  /** Min ms between feed continuity checks (default 600_000 — 10 min). */
  gapCheckIntervalMs?: number;
  /**
   * The network passphrase this deployment expects. When the Horizon root
   * document reports a passphrase and it differs, continuity bounds are
   * DISCARDED: gaps and resets must never be recorded from a Horizon that
   * serves a different network (a briefly-wrong HORIZON_URL would otherwise
   * poison the permanent gap store). Absent passphrases (minimal test doubles)
   * skip the comparison.
   */
  expectedNetworkPassphrase?: string;
  log: IngestLogger;
}

/**
 * The Horizon → store ingest loop.
 *
 * `start(startCursorSpec)` resolves the initial cursor ONLY on a fresh store
 * ('now' → the newest tx's paging_token, 'genesis' → '0', a decimal token →
 * as-is); once a cursor is persisted, the persisted state wins and the spec is
 * ignored. Ticks run on a setTimeout chain — the next tick is scheduled only
 * AFTER the previous one finishes, so ticks never overlap. A tick keeps paging
 * while pages come back full (cold catch-up drains in one tick) and stops at a
 * short or empty page.
 *
 * At most once per `gapCheckIntervalMs`, a tick STARTS with a feed continuity
 * check against Horizon's retention bounds: a `history_elder_ledger` past the
 * cursor means Horizon dropped ledgers before they were ingested (a permanent
 * hole, recorded via `store.recordGap` and surfaced as /health 'degraded');
 * a cursor impossibly far past `history_latest_ledger` flags a suspected
 * testnet reset under a stale database (`resetSuspected`). Because a recorded
 * gap is PERMANENT and a false one destroys a healthy deployment, the check
 * fails CLOSED in every direction: paging never starts before the process's
 * first successful check (a cold start against a broken root document must
 * not silently cross a retention hole), bounds from a mismatched network
 * passphrase are discarded, a hole must be observed on two consecutive checks
 * before it is recorded (paging pauses in between so the cursor cannot jump
 * the hole and un-observe it), and a persistently failing check surfaces as
 * `continuityStale` → /health 'degraded'.
 *
 * INVARIANT: the cursor never advances past a transaction whose operations
 * fetch failed — any error aborts the tick BEFORE that page's insertBatch,
 * records lastError, and the next tick retries from the same cursor. An
 * announcement silently skipped would be a hidden payment. The same rule
 * covers a Horizon/proxy serving out-of-order pages: every page is asserted
 * strictly ascending and strictly past the request cursor before it is
 * stored, because a token at/below the cursor would silently corrupt
 * coverage.
 */
export function createIngester({
  horizon,
  store,
  intervalMs,
  gapCheckIntervalMs = 600_000,
  expectedNetworkPassphrase,
  log,
}: IngesterOptions): Ingester {
  let cursor: string | null = null;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let lastPollAt: string | null = null;
  let lastError: string | null = null;
  let caughtUp = false;
  let resetSuspected = false;
  /** One reset observation awaiting its consecutive confirmation. */
  let resetPending = false;
  /** fromLedger of a hole observation awaiting its consecutive confirmation. */
  let pendingHoleFrom: number | null = null;
  let lastGapCheckAt: number | null = null;
  let lastContinuityOkAt: number | null = null;
  let lastProgressAt: number | null = null;
  let pagingGateLogged = false;

  async function resolveStartCursor(spec: string): Promise<string> {
    if (spec === 'now') {
      // Empty network (no transactions yet) → start from the beginning.
      return (await horizon.getLatestTransactionToken()) ?? '0';
    }
    if (spec === 'genesis') return '0';
    if (/^\d+$/.test(spec)) return spec;
    throw new Error(
      `INGEST_START='${spec}' is not supported: use 'now', 'genesis', or a ` +
        'decimal Horizon paging token.',
    );
  }

  /**
   * The feed continuity check (see the createIngester doc). `lastGapCheckAt`
   * is stamped only after a FULLY successful check: a bounds-fetch failure, a
   * passphrase mismatch, or an unconfirmed observation all leave it unset so
   * the next tick (interval, not gap-check cadence) retries. If `recordGap`
   * throws, the tick aborts before paging and the next tick re-detects the
   * hole instead of paging the cursor past it with the gap unrecorded.
   */
  async function checkFeedContinuity(): Promise<void> {
    let bounds: {
      elderLedger?: number;
      latestLedger?: number;
      networkPassphrase?: string;
    };
    try {
      bounds = await horizon.getFeedLedgerBounds();
    } catch (err) {
      log.warn('Feed continuity check failed; retrying next tick', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (
      expectedNetworkPassphrase !== undefined &&
      bounds.networkPassphrase !== undefined &&
      bounds.networkPassphrase !== expectedNetworkPassphrase
    ) {
      // A gap recorded from another network's retention bounds would be
      // false AND permanent — discard everything from this root document.
      log.error(
        'Horizon root document reports a DIFFERENT network; discarding ' +
          'continuity bounds. Check HORIZON_URL.',
        {
          expected: expectedNetworkPassphrase,
          got: bounds.networkPassphrase,
        },
      );
      return;
    }
    const cursorLedger = ledgerOfToken(cursor ?? '0');

    // RESET rule, evaluated FIRST: when the cursor is impossibly far past
    // the chain head the database belongs to a previous chain era, and
    // comparing its cursor against this chain's retention bounds (the HOLE
    // rule) would record cross-era garbage. One observation may be a stale
    // load-balancer snapshot; two consecutive observations LATCH the flag —
    // a stale-era database never becomes trustworthy again by the new chain
    // merely growing past the old cursor height, so only a restart (after a
    // wipe or HORIZON_URL fix) clears it.
    const resetObserved =
      bounds.latestLedger !== undefined &&
      cursorLedger > bounds.latestLedger + RESET_TOLERANCE_LEDGERS;
    if (resetSuspected) {
      // Latched — stays regardless of what this check observes.
    } else if (resetObserved && resetPending) {
      resetSuspected = true;
      log.error(
        'Testnet reset with a stale database CONFIRMED (two consecutive ' +
          'checks): the ingest cursor is far past Horizon\'s latest ledger. ' +
          'Wipe the store and re-ingest (or fix HORIZON_URL) and restart.',
        { cursorLedger, latestLedger: bounds.latestLedger },
      );
    } else if (resetObserved) {
      resetPending = true;
      log.warn(
        'Possible testnet reset under a stale database; re-checking next tick',
        { cursorLedger, latestLedger: bounds.latestLedger },
      );
    } else {
      resetPending = false;
    }

    // HOLE rule: elder past the cursor means ledgers up to elderLedger-1 can
    // never be served by this Horizon. The Math.max(..., 2) trigger guard
    // exists because ledger 1 (genesis) never contains transactions, so a
    // 'genesis' start against a Horizon whose history begins at ledger 2 is
    // NOT a hole. The recorded range STARTS AT THE CURSOR LEDGER itself: a
    // paging_token can sit mid-ledger, so the cursor ledger's tail may be
    // partially unserved — including it over-reports at worst (degrading
    // availability), while excluding it could hide payments. A hole is only
    // RECORDED on its second consecutive observation; in between, paging is
    // paused (see tick) so the cursor cannot advance to the elder and make
    // the hole unobservable before it is recorded.
    if (!resetSuspected && !resetPending) {
      if (
        bounds.elderLedger !== undefined &&
        bounds.elderLedger > Math.max(cursorLedger + 1, 2)
      ) {
        const fromLedger = Math.max(cursorLedger, 2);
        const toLedger = bounds.elderLedger - 1;
        if (pendingHoleFrom === fromLedger) {
          await store.recordGap(fromLedger, toLedger, new Date().toISOString());
          pendingHoleFrom = null;
          log.error(
            'Feed hole CONFIRMED: Horizon retention advanced past the ingest ' +
              'cursor; this ledger range can never be ingested from this ' +
              'Horizon',
            {
              fromLedger,
              toLedger,
              cursorLedger,
              elderLedger: bounds.elderLedger,
            },
          );
        } else {
          pendingHoleFrom = fromLedger;
          log.warn(
            'Possible feed hole; paging paused until the next check confirms ' +
              'or clears it',
            { fromLedger, toLedger, cursorLedger },
          );
          // Unconfirmed: not a successful check — the next tick re-checks.
          return;
        }
      } else if (pendingHoleFrom !== null) {
        pendingHoleFrom = null;
        log.info('Pending feed hole not re-observed; resuming ingestion');
      }
    }

    lastContinuityOkAt = Date.now();
    lastGapCheckAt = lastContinuityOkAt;
  }

  async function tick(): Promise<void> {
    try {
      if (
        lastGapCheckAt === null ||
        pendingHoleFrom !== null ||
        resetPending ||
        Date.now() - lastGapCheckAt >= gapCheckIntervalMs
      ) {
        await checkFeedContinuity();
      }
      // Fail closed: never advance the cursor before this process's first
      // successful continuity check, and never while a hole observation
      // awaits confirmation — paging would jump the hole and un-observe it.
      if (lastContinuityOkAt === null || pendingHoleFrom !== null) {
        if (!pagingGateLogged) {
          pagingGateLogged = true;
          log.warn(
            'Paging paused until the feed continuity check succeeds',
            { pendingHoleFrom },
          );
        }
        return;
      }
      pagingGateLogged = false;
      for (;;) {
        if (!running) return;
        const page = await horizon.getTransactions(cursor ?? undefined, PAGE_LIMIT);
        if (page.length === 0) break;

        // Feed-order sanity: tokens must be strictly ascending and strictly
        // past the request cursor. A misbehaving Horizon/proxy violating this
        // could otherwise corrupt coverage silently, so the violation throws
        // (aborting the tick BEFORE insertBatch, per the invariant above).
        let previous = cursor === null ? null : BigInt(cursor);
        for (const tx of page) {
          const token = BigInt(tx.paging_token);
          if (previous !== null && token <= previous) {
            throw new Error(
              `Horizon feed order violation: paging_token ${tx.paging_token} ` +
                `is not strictly after ${previous}`,
            );
          }
          previous = token;
        }

        const collected: AnnouncementRecord[] = [];
        for (const tx of page) {
          // Only hash-memo announcements from successful transactions. Horizon
          // omits `successful` on some record shapes; treat only an explicit
          // false as failed.
          if (tx.memo_type !== 'hash' || !tx.memo || tx.successful === false) {
            continue;
          }
          // Serial ops fetches on purpose (simple, and each throw must abort
          // the tick before this page's insertBatch — see the invariant above).
          const operations = await horizon.getOperations(tx.hash);
          collected.push({
            pagingToken: tx.paging_token,
            hash: tx.hash,
            memo: tx.memo,
            closeTime: tx.created_at,
            operations,
            sourceAccount: tx.source_account,
          });
        }

        // ONE atomic write per page: announcements + cursor + lastCloseTime.
        const last = page[page.length - 1]!;
        await store.insertBatch(collected, last.paging_token, last.created_at);
        cursor = last.paging_token;
        lastProgressAt = Date.now();

        if (page.length < PAGE_LIMIT) break;
      }
      caughtUp = true;
      lastError = null;
      lastProgressAt = Date.now();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      caughtUp = false;
      log.warn('Ingest tick failed; retrying from the same cursor', {
        error: lastError,
        cursor,
      });
    } finally {
      lastPollAt = new Date().toISOString();
      if (running) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  }

  return {
    async start(startCursorSpec: string): Promise<void> {
      if (running) return;
      const state = await store.getIngestState();
      if (state.cursor !== null) {
        // Persisted progress wins; INGEST_START only seeds a FRESH store.
        cursor = state.cursor;
      } else {
        const resolved = await resolveStartCursor(startCursorSpec);
        await store.setStartCursor(resolved);
        // Persist the resolved position immediately (empty batch advances the
        // cursor atomically) so a restart before the first tick does not
        // re-resolve 'now' to a later position and skip the gap.
        await store.insertBatch([], resolved, null);
        cursor = resolved;
      }
      running = true;
      lastProgressAt = Date.now();
      log.info('Ingester started', { cursor, intervalMs });
      timer = setTimeout(() => void tick(), 0);
    },

    stop(): void {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    status(): IngesterStatus {
      const now = Date.now();
      const continuityStale =
        lastContinuityOkAt === null ||
        now - lastContinuityOkAt >
          Math.max(
            CONTINUITY_STALE_MIN_MS,
            CONTINUITY_STALE_AFTER_CHECKS * gapCheckIntervalMs,
          );
      const stalled =
        lastProgressAt !== null &&
        now - lastProgressAt >
          Math.max(STALL_MIN_MS, STALL_AFTER_INTERVALS * intervalMs);
      return {
        lastPollAt,
        lastError,
        caughtUp,
        resetSuspected,
        lastContinuityOkAt:
          lastContinuityOkAt === null
            ? null
            : new Date(lastContinuityOkAt).toISOString(),
        continuityStale,
        stalled,
      };
    },
  };
}
