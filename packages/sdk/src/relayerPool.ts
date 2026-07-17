import { RelayerClient } from './relayer.js';
import type { FundingSigner, RelayerHealth } from './relayer.js';
import type { FetchLike } from './horizon.js';
import type { NetworkName, TransactionStatusSource } from './soroban.js';
import {
  NoHealthyRelayerError,
  RelayerHttpError,
  RelayerNetworkError,
} from './errors.js';

/**
 * How a healthy relayer is picked from the candidate list. `'random'` is the
 * default deliberately: users spread across the relayer set instead of herding
 * onto the first entry, preserving the anonymity-set benefit of shared
 * relayers. `'first'` gives deterministic priority ordering.
 */
export type RelayerSelection = 'random' | 'first';

/** Tuning knobs for a {@link RelayerPool}. Every field has a safe default. */
export interface RelayerPoolOpts {
  /**
   * Network name a candidate's `/health` must report. Omit (or an unknown
   * passphrase upstream) to skip the check; a candidate that reports no
   * network also passes — only an explicit contradiction rejects.
   */
  network?: NetworkName;
  /** Selection strategy. Default `'random'`. */
  selection?: RelayerSelection;
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchFn?: FetchLike;
  /** Shared parallel `/health` probe budget in ms. Default 2500. */
  probeTimeoutMs?: number;
  /**
   * Per-attempt budget in ms inside {@link RelayerPool.withRelayer}, applied
   * ONLY while a failover alternative remains. Default 10000.
   */
  attemptTimeoutMs?: number;
  /**
   * Minimum XLM balance a candidate must report to count as healthy — a
   * relayer one fee-bump from empty is operationally dead. Default 1 XLM
   * (~10 fee-bumps at the default 0.1 cap).
   */
  minBalanceXlm?: number;
  /** Probe cache TTL in ms (per pool instance). Default 30000. */
  probeTtlMs?: number;
  /** Injectable RNG for `'random'` selection (tests). Default `Math.random`. */
  rng?: () => number;
}

/**
 * Per-call context the health rule and the built clients need: a credit-gated
 * relayer only counts as healthy when the caller can actually pass its gate
 * (`fundingAccount` + `fundingSigner` present).
 */
export interface RelayerCallCtx {
  fundingAccount?: string;
  fundingSigner?: FundingSigner;
  rpcServer?: TransactionStatusSource;
}

/** One candidate's probe result: a health document, or the rejection reason. */
export interface ProbeOutcome {
  url: string;
  health?: RelayerHealth;
  reason?: string;
}

/**
 * Normalize a relayer config value into a clean URL list: trims entries, drops
 * empties, and collapses an empty result to `undefined` so `[]` and `['']`
 * mean "no relayer" everywhere a truthiness check gates relayed behavior
 * (e.g. the account claim's merge-fee arithmetic).
 */
export function normalizeRelayList(
  relay?: string | string[],
): string[] | undefined {
  if (relay === undefined) return undefined;
  const list = (Array.isArray(relay) ? relay : [relay])
    .map((url) => url.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_RELAYER_BALANCE_XLM = 1;
const DEFAULT_PROBE_TTL_MS = 30_000;

/** Race marker distinguishing a timeout from any value the work can produce. */
const TIMED_OUT: unique symbol = Symbol('timed out');

/**
 * Race a promise against a clearable timer. Deliberately NOT
 * `AbortSignal.timeout`: the injectable {@link FetchLike} carries no signal,
 * and platform timers are invisible to vitest's fake timers — a plain
 * `setTimeout` keeps both the abandonment semantics and the tests honest. The
 * losing promise is left running; its rejection (if any) is swallowed by the
 * detached guard so it cannot surface as an unhandled rejection.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  void promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Fisher–Yates shuffle in place with an injectable RNG. */
function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

/**
 * Health-probing selector and failover harness over a list of relayer URLs
 * (A3 BYO-relayer discovery).
 *
 * A candidate is healthy iff its `/health` reports `status === 'ok'`, its
 * network matches the expected one (when both sides are known), its balance
 * meets the minimum, and its credit gate is passable — `requireCredit ===
 * false`, or the caller brought funding auth. `requireCredit` missing is
 * treated as gated (fail-closed, matching the relayer's gating-on default).
 *
 * A single-URL pool is a transparent pass-through: no probe, no timeout —
 * byte-identical behavior to constructing a `RelayerClient` directly, so
 * existing single-relayer callers see no new traffic or failure modes.
 */
export class RelayerPool {
  readonly candidates: readonly string[];
  private readonly network?: NetworkName;
  private readonly selection: RelayerSelection;
  private readonly fetchFn?: FetchLike;
  private readonly probeTimeoutMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly minBalanceXlm: number;
  private readonly probeTtlMs: number;
  private readonly rng: () => number;
  private cachedProbe?: ProbeOutcome[];
  private cachedProbeAt = 0;

  constructor(candidates: string[], opts?: RelayerPoolOpts) {
    if (candidates.length === 0) {
      throw new Error('RelayerPool requires at least one candidate URL');
    }
    this.candidates = [...candidates];
    this.network = opts?.network;
    this.selection = opts?.selection ?? 'random';
    this.fetchFn = opts?.fetchFn;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.attemptTimeoutMs = opts?.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.minBalanceXlm = opts?.minBalanceXlm ?? DEFAULT_MIN_RELAYER_BALANCE_XLM;
    this.probeTtlMs = opts?.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
    this.rng = opts?.rng ?? Math.random;
  }

  /**
   * Build a pool from any accepted relayer config shape, or `undefined` when
   * the input normalizes to "no relayer" — the back-compat seam that lets
   * `RelayerPool.from(opts.relay)` slot in wherever a single URL was used.
   */
  static from(
    relay: string | string[] | undefined,
    opts?: RelayerPoolOpts,
  ): RelayerPool | undefined {
    const list = normalizeRelayList(relay);
    return list ? new RelayerPool(list, opts) : undefined;
  }

  /**
   * Probe every candidate's `/health` in parallel under one shared time
   * budget. Results are cached per pool instance for {@link
   * RelayerPoolOpts.probeTtlMs}; `force` refreshes. Only transport-level
   * outcomes are recorded here — health-rule classification happens per call
   * in {@link select}/{@link withRelayer}, because it depends on the caller's
   * funding context.
   */
  async probe(force = false): Promise<ProbeOutcome[]> {
    const now = Date.now();
    if (
      !force &&
      this.cachedProbe &&
      now - this.cachedProbeAt < this.probeTtlMs
    ) {
      return this.cachedProbe;
    }
    const outcomes = await Promise.all(
      this.candidates.map(async (url): Promise<ProbeOutcome> => {
        const client = new RelayerClient(url, this.fetchFn);
        try {
          const health = await withTimeout(client.health(), this.probeTimeoutMs);
          if (health === TIMED_OUT) return { url, reason: 'timeout' };
          return { url, health };
        } catch (err) {
          if (err instanceof RelayerHttpError) {
            return { url, reason: `http_${err.status}` };
          }
          const detail = err instanceof Error ? err.message : String(err);
          return { url, reason: `unreachable: ${detail}` };
        }
      }),
    );
    this.cachedProbe = outcomes;
    this.cachedProbeAt = now;
    return outcomes;
  }

  /**
   * Pick one healthy relayer URL for this call, or throw
   * {@link NoHealthyRelayerError} naming every candidate's rejection reason.
   * A single-candidate pool returns its URL without probing (pass-through).
   */
  async select(ctx?: RelayerCallCtx): Promise<string> {
    if (this.candidates.length === 1) return this.candidates[0]!;
    const { healthy, reasons } = await this.rankHealthy(ctx);
    if (healthy.length === 0) throw new NoHealthyRelayerError(reasons);
    return healthy[0]!;
  }

  /**
   * Run `fn` against a selected relayer, failing over to the next healthy
   * candidate ONLY on transport faults — {@link RelayerNetworkError}, a 5xx
   * {@link RelayerHttpError}, or an attempt timeout. A 4xx (bad request,
   * insufficient credit) or any non-transport error would just repeat and
   * rethrows immediately. At most 2 attempts; the attempt timeout applies
   * only while another candidate remains.
   *
   * Failover after an ambiguous timeout cannot double-spend: both attempts
   * fee-bump the SAME signed inner tx, so its sequence number lets at most
   * one land (`txBAD_SEQ` for the loser).
   */
  async withRelayer<T>(
    fn: (client: RelayerClient, url: string) => Promise<T>,
    ctx?: RelayerCallCtx,
  ): Promise<T> {
    if (this.candidates.length === 1) {
      const url = this.candidates[0]!;
      return fn(this.buildClient(url, ctx), url);
    }
    const { healthy, reasons } = await this.rankHealthy(ctx);
    if (healthy.length === 0) throw new NoHealthyRelayerError(reasons);

    const attempts = healthy.slice(0, 2);
    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const url = attempts[i]!;
      const hasFallback = i < attempts.length - 1;
      try {
        const attempt = fn(this.buildClient(url, ctx), url);
        const result = hasFallback
          ? await withTimeout(attempt, this.attemptTimeoutMs)
          : await attempt;
        if (result === TIMED_OUT) {
          lastError = new RelayerNetworkError(
            url,
            `attempt timed out after ${this.attemptTimeoutMs}ms`,
          );
          continue;
        }
        return result as T;
      } catch (err) {
        const transient =
          err instanceof RelayerNetworkError ||
          (err instanceof RelayerHttpError && err.status >= 500);
        if (transient && hasFallback) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** Per-call client carrying the caller's funding auth + confirm handle. */
  private buildClient(url: string, ctx?: RelayerCallCtx): RelayerClient {
    return new RelayerClient(url, this.fetchFn, {
      fundingAccount: ctx?.fundingAccount,
      fundingSigner: ctx?.fundingSigner,
      rpcServer: ctx?.rpcServer,
    });
  }

  /**
   * Classify every probed candidate for this call's context and order the
   * healthy ones by the selection strategy.
   */
  private async rankHealthy(ctx?: RelayerCallCtx): Promise<{
    healthy: string[];
    reasons: Record<string, string>;
  }> {
    const outcomes = await this.probe();
    const healthy: string[] = [];
    const reasons: Record<string, string> = {};
    for (const outcome of outcomes) {
      if (!outcome.health) {
        reasons[outcome.url] = outcome.reason ?? 'unreachable';
        continue;
      }
      const reason = this.healthReason(outcome.health, ctx);
      if (reason) reasons[outcome.url] = reason;
      else healthy.push(outcome.url);
    }
    if (this.selection === 'random') shuffle(healthy, this.rng);
    return { healthy, reasons };
  }

  /** The health rule. Returns the rejection reason, or `undefined` = healthy. */
  private healthReason(
    health: RelayerHealth,
    ctx?: RelayerCallCtx,
  ): string | undefined {
    if (health.status !== 'ok') return 'status_not_ok';
    if (
      this.network !== undefined &&
      health.network !== undefined &&
      health.network !== this.network
    ) {
      return `network_mismatch (${health.network} != ${this.network})`;
    }
    if (health.balance !== undefined) {
      const balance = Number(health.balance);
      if (!Number.isFinite(balance) || balance < this.minBalanceXlm) {
        return `balance_below_min (${health.balance} < ${this.minBalanceXlm})`;
      }
    }
    // requireCredit missing = treated as gated: the relayer defaults gating ON,
    // so an old/withholding relayer must not be routed to without funding auth.
    const hasFundingAuth = !!(ctx?.fundingAccount && ctx?.fundingSigner);
    if (health.requireCredit !== false && !hasFundingAuth) {
      return 'credit_gated_no_funding_auth';
    }
    return undefined;
  }
}
