import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/** One movement in an account's credit history. */
export interface LedgerHistoryEntry {
  type: 'credit' | 'debit';
  amount: string;
  ref: string;
  at: string;
}

/** One movement in an account's sponsored-reserve hold history. */
export interface HoldHistoryEntry {
  type: 'hold' | 'release';
  amount: string;
  ref: string;
  at: string;
}

/**
 * Per-ref net-applied counters. `debit` counts debits minus refunds for a ref;
 * `hold` counts holds minus releases for a ref. These give O(1) idempotency and
 * retry-after-refund decisions without scanning the (bounded) history array.
 */
export interface RefCounters {
  debit?: Record<string, number>;
  hold?: Record<string, number>;
}

/** Per-account credit bookkeeping. */
export interface LedgerAccount {
  balance: string;
  sponsoredHeld: string;
  updatedAt: string;
  history: LedgerHistoryEntry[];
  /** Sponsored-reserve hold/release history (refund-aware, mirrors `history`). */
  holdHistory?: HoldHistoryEntry[];
  /**
   * O(1) net-applied counters per ref (debit-minus-refund, hold-minus-release).
   * Authoritative for idempotency; `history`/`holdHistory` are a bounded, purely
   * informational trail that may be rotated/capped without affecting decisions.
   */
  refCounters?: RefCounters;
  /** Total entries ever appended to `history` (survives history rotation). */
  historyTotal?: number;
  /** Total entries ever appended to `holdHistory` (survives rotation). */
  holdHistoryTotal?: number;
}

/**
 * Max entries retained in each per-account history trail. Older entries are
 * dropped (rotated out) once the cap is exceeded so history cannot grow without
 * bound. Idempotency decisions never read the trail (see {@link RefCounters}),
 * so rotation is safe.
 */
const MAX_HISTORY_ENTRIES = 200;

/** Terminal state of a reservation once its route has resolved. */
export type ReservationState = 'OUTSTANDING' | 'SETTLED' | 'REFUNDED';

/** Persisted per-reservation record, keyed by the reservation's unique id. */
export interface ReservationRecord {
  account: string;
  amount: string;
  ref: string;
  /** Whether this reservation actually moved credit (a no-op reserve did not). */
  debited: boolean;
  state: ReservationState;
  /**
   * ISO timestamp when this reservation was created. Present on records written
   * by this version; absent on legacy records persisted before the field was
   * added. A later recovery job uses it to age OUTSTANDING reservations.
   */
  createdAt?: string;
}

/** On-disk shape of the credit ledger. */
export interface LedgerData {
  version: 1;
  consumedTxs: Record<string, string>;
  accounts: Record<string, LedgerAccount>;
  /** Reservation records keyed by unique reservation id (terminal state). */
  reservations: Record<string, ReservationRecord>;
}

/**
 * A credit reservation taken BEFORE a route submits its transaction. The fee is
 * already debited from the account when the reservation is returned. After a
 * SUCCESSFUL submit call {@link CreditLedger.settle} to make the charge terminal;
 * if the submit throws call {@link CreditLedger.refund} to restore the credit.
 * Each reservation carries a unique {@link id} so replays cannot refund an
 * already-settled charge.
 */
export interface Reservation {
  /** Unique reservation id — the terminal-state key. */
  id: string;
  account: string;
  amount: string;
  ref: string;
  /** True when this reservation actually debited (false on an idempotent no-op). */
  debited: boolean;
}

/**
 * An all-async, stroop-precision credit ledger. Every method returns a Promise
 * so a durable backend (e.g. Postgres) that cannot answer synchronously can
 * implement the same contract. {@link JsonCreditLedger} is the default JSON-file
 * implementation; call sites depend on this interface, not the concrete class.
 */
export interface CreditLedger {
  /** Whether a deposit tx hash has already been credited. */
  hasConsumed(txHash: string): Promise<boolean>;
  /** Current balance (decimal string) for an account, or null if unknown. */
  getBalance(account: string): Promise<string | null>;
  /** Full account record, or null if unknown. */
  getAccount(account: string): Promise<LedgerAccount | null>;
  /** Whether an account has at least `amount` credit available. */
  hasSufficient(account: string, amount: string): Promise<boolean>;
  /**
   * Credit an account from a verified deposit tx. Idempotent: a repeated
   * txHash rejects so the caller can return 409.
   */
  credit(account: string, amount: string, txHash: string): Promise<LedgerAccount>;
  /**
   * Debit an account by an amount. Rejects `insufficient_credit` when the
   * balance would go negative. Idempotent by `ref`.
   */
  debit(account: string, amount: string, ref: string): Promise<LedgerAccount>;
  /**
   * Atomically check credit and debit the fee BEFORE the caller submits.
   * Rejects `insufficient_credit` when the balance would go negative.
   * Idempotent by `ref`.
   */
  reserve(account: string, amount: string, ref: string): Promise<Reservation>;
  /**
   * Mark a reservation SETTLED after a SUCCESSFUL submit. When `actualAmount`
   * (decimal XLM string, e.g. the on-chain fee_charged) is given, only that
   * much of the reserved amount is kept and the remainder is credited back in
   * the same atomic step. The actual is clamped into [0, reserved];
   * unparseable input settles the full amount. Idempotent: only an
   * OUTSTANDING reservation flips, exactly once.
   */
  settle(reservation: Reservation, actualAmount?: string): Promise<void>;
  /** Restore a previously reserved amount after a FAILED submit. */
  refund(reservation: Reservation): Promise<void>;
  /**
   * Record sponsored reserves the relayer fronts for a funding account and
   * return the new held total. Rejects `sponsored_held_exceeded` when the
   * addition would push held reserves above `maxHeld`.
   */
  holdReserve(
    account: string,
    amount: string,
    maxHeld: string,
    ref?: string,
  ): Promise<string>;
  /** Release previously held sponsored reserves (clamped at zero). */
  releaseReserve(account: string, amount: string, ref?: string): Promise<string>;
}

const STROOPS_PER_UNIT = 10_000_000n;

/** Parse a decimal XLM string into integer stroops (throws on garbage). */
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const paddedFraction = (fraction + '0000000').slice(0, 7);
  const stroops =
    BigInt(whole || '0') * STROOPS_PER_UNIT + BigInt(paddedFraction || '0');
  return negative ? -stroops : stroops;
}

/**
 * Clamp a settle-time actual amount into [0, reserved] stroops. Garbage input
 * settles the full reserved amount: reconciliation runs AFTER a successful
 * submit, so degrading to the pre-reconciliation debit is the safe direction —
 * a throw here would leave the reservation OUTSTANDING and let the recovery
 * sweep refund a legitimately charged fee.
 */
export function clampSettleStroops(actual: string, reservedStroops: bigint): bigint {
  let v: bigint;
  try {
    v = toStroops(actual);
  } catch {
    return reservedStroops;
  }
  if (v < 0n) return 0n;
  if (v > reservedStroops) return reservedStroops;
  return v;
}

/** Render integer stroops back to a 7-dp decimal string. */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = abs % STROOPS_PER_UNIT;
  const fractionStr = fraction.toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${fractionStr}`;
}

/**
 * A durable, stroop-precision {@link CreditLedger} backed by a single JSON file.
 *
 * All arithmetic is done on BigInt stroops (never floats), and writes are
 * atomic (write-tmp + rename) so a crash mid-write cannot corrupt the ledger.
 * Consumed deposit tx hashes are recorded to make credit claims idempotent.
 * The read/write methods are synchronous internally but exposed as Promises to
 * satisfy the {@link CreditLedger} contract; per-account promise locks still
 * serialize reserve-check-and-debit.
 */
export class JsonCreditLedger implements CreditLedger {
  private readonly filePath: string;
  private data: LedgerData;
  /** Per-account promise chains that serialize reserve-check-and-debit. */
  private readonly locks: Map<string, Promise<unknown>> = new Map();

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      process.env.CREDIT_LEDGER_PATH ||
      path.join(process.cwd(), 'data', 'credit-ledger.json');
    this.data = this.load();
  }

  private load(): LedgerData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as LedgerData;
      if (!parsed.accounts) parsed.accounts = {};
      if (!parsed.consumedTxs) parsed.consumedTxs = {};
      if (!parsed.reservations) parsed.reservations = {};
      return parsed;
    } catch {
      return {
        version: 1,
        consumedTxs: {},
        accounts: {},
        reservations: {},
      };
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  private ensureAccount(account: string): LedgerAccount {
    let acct = this.data.accounts[account];
    if (!acct) {
      acct = {
        balance: '0.0000000',
        sponsoredHeld: '0.0000000',
        updatedAt: new Date().toISOString(),
        history: [],
        holdHistory: [],
        refCounters: { debit: {}, hold: {} },
        historyTotal: 0,
        holdHistoryTotal: 0,
      };
      this.data.accounts[account] = acct;
    }
    // Backfill fields for ledgers persisted before this schema. When migrating a
    // legacy ledger that only has history arrays, reconstruct the net counters
    // once so idempotency is preserved across the upgrade.
    if (!acct.refCounters) {
      acct.refCounters = { debit: {}, hold: {} };
      for (const h of acct.history) {
        if (h.type === 'debit') {
          this.bumpCounter(acct.refCounters.debit!, h.ref, 1);
        } else if (h.type === 'credit' && h.ref.startsWith('refund:')) {
          this.bumpCounter(acct.refCounters.debit!, h.ref.slice('refund:'.length), -1);
        }
      }
      for (const h of acct.holdHistory ?? []) {
        this.bumpCounter(acct.refCounters.hold!, h.ref, h.type === 'hold' ? 1 : -1);
      }
    }
    if (!acct.refCounters.debit) acct.refCounters.debit = {};
    if (!acct.refCounters.hold) acct.refCounters.hold = {};
    if (acct.historyTotal === undefined) acct.historyTotal = acct.history.length;
    if (acct.holdHistoryTotal === undefined) {
      acct.holdHistoryTotal = acct.holdHistory?.length ?? 0;
    }
    return acct;
  }

  /** Adjust a per-ref counter, pruning it to keep the map from growing at zero. */
  private bumpCounter(map: Record<string, number>, ref: string, delta: number): number {
    const next = (map[ref] ?? 0) + delta;
    if (next === 0) {
      delete map[ref];
    } else {
      map[ref] = next;
    }
    return next;
  }

  /** Append to the credit trail with rotation so it stays bounded. */
  private pushHistory(acct: LedgerAccount, entry: LedgerHistoryEntry): void {
    acct.history.push(entry);
    acct.historyTotal = (acct.historyTotal ?? 0) + 1;
    if (acct.history.length > MAX_HISTORY_ENTRIES) {
      acct.history.splice(0, acct.history.length - MAX_HISTORY_ENTRIES);
    }
  }

  /** Append to the hold trail with rotation so it stays bounded. */
  private pushHoldHistory(acct: LedgerAccount, entry: HoldHistoryEntry): void {
    if (!acct.holdHistory) acct.holdHistory = [];
    acct.holdHistory.push(entry);
    acct.holdHistoryTotal = (acct.holdHistoryTotal ?? 0) + 1;
    if (acct.holdHistory.length > MAX_HISTORY_ENTRIES) {
      acct.holdHistory.splice(0, acct.holdHistory.length - MAX_HISTORY_ENTRIES);
    }
  }

  /** Synchronous idempotency check reused by {@link credit}. */
  private hasConsumedSync(txHash: string): boolean {
    return txHash in this.data.consumedTxs;
  }

  /** Whether a deposit tx hash has already been credited. */
  async hasConsumed(txHash: string): Promise<boolean> {
    return this.hasConsumedSync(txHash);
  }

  /** Current balance (decimal string) for an account, or null if unknown. */
  async getBalance(account: string): Promise<string | null> {
    return this.data.accounts[account]?.balance ?? null;
  }

  /** Full account record, or null if unknown. */
  async getAccount(account: string): Promise<LedgerAccount | null> {
    return this.data.accounts[account] ?? null;
  }

  /**
   * Credit an account from a verified deposit tx. Idempotent: a repeated
   * txHash throws so the caller can return 409.
   */
  async credit(account: string, amount: string, txHash: string): Promise<LedgerAccount> {
    if (this.hasConsumedSync(txHash)) {
      throw new Error('tx_already_claimed');
    }
    const acct = this.ensureAccount(account);
    const next = toStroops(acct.balance) + toStroops(amount);
    acct.balance = fromStroops(next);
    acct.updatedAt = new Date().toISOString();
    this.pushHistory(acct, {
      type: 'credit',
      amount,
      ref: txHash,
      at: acct.updatedAt,
    });
    this.data.consumedTxs[txHash] = account;
    this.persist();
    return acct;
  }

  /**
   * Debit an account by an amount. Throws `insufficient_credit` when the
   * balance would go negative. Idempotent by `ref`: a debit whose `ref` was
   * already applied is a no-op (returns the account unchanged) rather than
   * double-charging.
   */
  async debit(account: string, amount: string, ref: string): Promise<LedgerAccount> {
    return this.debitInternal(account, amount, ref).acct;
  }

  /**
   * Apply a debit and report whether it actually moved credit. A ref is "already
   * applied" only when it has a debit that was NOT subsequently refunded.
   * Counting debits vs. refunds for this ref lets a refunded reservation be
   * re-debited on a genuine retry (same signed tx => same ref) instead of
   * hitting a free no-op, while a plain duplicate debit with no intervening
   * refund stays idempotent (returns `debited: false`).
   */
  private debitInternal(
    account: string,
    amount: string,
    ref: string,
  ): { acct: LedgerAccount; debited: boolean } {
    const acct = this.ensureAccount(account);
    // O(1): the net counter is (debits - refunds) for this ref. A positive
    // value means there is an outstanding, un-refunded debit => idempotent no-op.
    const net = acct.refCounters!.debit![ref] ?? 0;
    if (net > 0) {
      return { acct, debited: false };
    }
    const remaining = toStroops(acct.balance) - toStroops(amount);
    if (remaining < 0n) {
      throw new Error('insufficient_credit');
    }
    acct.balance = fromStroops(remaining);
    acct.updatedAt = new Date().toISOString();
    this.bumpCounter(acct.refCounters!.debit!, ref, 1);
    this.pushHistory(acct, {
      type: 'debit',
      amount,
      ref,
      at: acct.updatedAt,
    });
    this.persist();
    return { acct, debited: true };
  }

  /** Whether an account has at least `amount` credit available. */
  async hasSufficient(account: string, amount: string): Promise<boolean> {
    const acct = this.data.accounts[account];
    if (!acct) return false;
    return toStroops(acct.balance) >= toStroops(amount);
  }

  /**
   * Run `fn` under a per-account lock so concurrent callers on the same account
   * are serialized (reserve-check-and-debit is atomic). Callers on different
   * accounts still run in parallel.
   */
  private async withLock<T>(account: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(account) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => gate);
    this.locks.set(account, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(account) === chained) {
        this.locks.delete(account);
      }
    }
  }

  /**
   * Atomically check credit and debit the fee BEFORE the caller submits. Under
   * the per-account lock two concurrent reservations against a balance that only
   * covers one will not both succeed. Throws `insufficient_credit` when the
   * balance would go negative. Idempotent by `ref`.
   *
   * @returns A {@link Reservation} to pass to {@link refund} if the subsequent
   *   submit throws.
   */
  async reserve(account: string, amount: string, ref: string): Promise<Reservation> {
    return this.withLock(account, () => {
      const { debited } = this.debitInternal(account, amount, ref);
      const id = randomUUID();
      this.data.reservations[id] = {
        account,
        amount,
        ref,
        debited,
        state: 'OUTSTANDING',
        // Timestamp so a later recovery job can age OUTSTANDING reservations
        // (a crash between reserve and settle/refund).
        createdAt: new Date().toISOString(),
      };
      this.persist();
      return { id, account, amount, ref, debited };
    });
  }

  /**
   * Mark a reservation SETTLED after a SUCCESSFUL submit. A settled reservation
   * can never be refunded — a replay of the same signed tx within the TTL is a
   * refund no-op, so the relayer keeps the fee it legitimately charged. Settling
   * an unknown or already-terminal reservation is a no-op.
   *
   * When `actualAmount` is given (the on-chain fee_charged), only that much of
   * the reserved amount is kept: the remainder is credited back in the same
   * atomic persist under the `adjust:` ref prefix. NOT `refund:` — the legacy
   * counter backfill in {@link ensureAccount} re-derives net debit counters
   * from history and decrements on `refund:`-prefixed credits, and an
   * adjustment must not decrement: the charge is terminal, so a replayed
   * reserve of the same ref must stay an idempotent no-op exactly like a full
   * settle.
   */
  async settle(reservation: Reservation, actualAmount?: string): Promise<void> {
    await this.withLock(reservation.account, () => {
      const rec = this.data.reservations[reservation.id];
      if (!rec || rec.state !== 'OUTSTANDING') return;
      rec.state = 'SETTLED';
      if (actualAmount !== undefined && rec.debited) {
        const reserved = toStroops(rec.amount);
        const remainder = reserved - clampSettleStroops(actualAmount, reserved);
        if (remainder > 0n) {
          const acct = this.ensureAccount(rec.account);
          acct.balance = fromStroops(toStroops(acct.balance) + remainder);
          acct.updatedAt = new Date().toISOString();
          this.pushHistory(acct, {
            type: 'credit',
            amount: fromStroops(remainder),
            ref: `adjust:${rec.ref}`,
            at: acct.updatedAt,
          });
        }
      }
      this.persist();
    });
  }

  /**
   * Restore a previously {@link reserve}d amount after a FAILED submit. Restores
   * balance ONLY when the reservation actually debited and is still OUTSTANDING
   * (not settled, not already refunded). A refund of a settled, already-refunded,
   * no-op, or unknown reservation is a no-op so it can neither over-credit nor
   * undo a legitimate charge.
   */
  async refund(reservation: Reservation): Promise<void> {
    await this.withLock(reservation.account, () => {
      const rec = this.data.reservations[reservation.id];
      if (!rec || rec.state !== 'OUTSTANDING' || !rec.debited) {
        // Backwards/edge safety: an unknown-id reservation is treated as a
        // no-op (never restore credit for a reservation we did not record).
        if (rec && rec.state === 'OUTSTANDING' && !rec.debited) {
          rec.state = 'REFUNDED';
          this.persist();
        }
        return;
      }
      const acct = this.ensureAccount(rec.account);
      const next = toStroops(acct.balance) + toStroops(rec.amount);
      acct.balance = fromStroops(next);
      acct.updatedAt = new Date().toISOString();
      // O(1): decrement the net debit counter so a genuine retry of the SAME
      // signed tx (same ref) re-debits instead of hitting the no-op path.
      this.bumpCounter(acct.refCounters!.debit!, rec.ref, -1);
      this.pushHistory(acct, {
        type: 'credit',
        amount: rec.amount,
        ref: `refund:${rec.ref}`,
        at: acct.updatedAt,
      });
      rec.state = 'REFUNDED';
      this.persist();
    });
  }

  /**
   * Record sponsored reserves (base reserve + trustline) the relayer fronts for a
   * funding account and return the new held total. Enforce a per-funder ceiling:
   * throws `sponsored_held_exceeded` when the addition would push the account's
   * held reserves above `maxHeld`.
   *
   * Refund-aware by `ref` when supplied (mirrors {@link debitInternal}): a hold is
   * "already applied" for a ref only when it has a hold that was NOT subsequently
   * released. Counting holds vs. releases per ref lets a released ref re-hold on a
   * genuine retry of the SAME signed tx (submit failed, hold released, client
   * resubmits the identical tx) instead of hitting a free no-op, while a plain
   * duplicate hold with no intervening release stays idempotent (no-op). Calls
   * without a `ref` keep the legacy unconditional-add behaviour.
   */
  async holdReserve(
    account: string,
    amount: string,
    maxHeld: string,
    ref?: string,
  ): Promise<string> {
    return this.withLock(account, () => {
      const acct = this.ensureAccount(account);
      if (ref) {
        // O(1): net counter is (holds - releases) for this ref. A positive value
        // means an outstanding (not-yet-released) hold => idempotent no-op.
        const net = acct.refCounters!.hold![ref] ?? 0;
        if (net > 0) {
          return acct.sponsoredHeld;
        }
      }
      const next = toStroops(acct.sponsoredHeld) + toStroops(amount);
      if (next > toStroops(maxHeld)) {
        throw new Error('sponsored_held_exceeded');
      }
      acct.sponsoredHeld = fromStroops(next);
      acct.updatedAt = new Date().toISOString();
      if (ref) {
        this.bumpCounter(acct.refCounters!.hold!, ref, 1);
        this.pushHoldHistory(acct, {
          type: 'hold',
          amount,
          ref,
          at: acct.updatedAt,
        });
      }
      this.persist();
      return acct.sponsoredHeld;
    });
  }

  /**
   * Release previously {@link holdReserve}d reserves (clamped at zero). When a
   * `ref` is supplied the release is recorded in `holdHistory` so a subsequent
   * {@link holdReserve} with the SAME ref can re-apply on a genuine retry (the
   * hold/release counts balance out). A release for a ref with no outstanding
   * hold is a no-op (never over-releases). Calls without a `ref` keep the legacy
   * unconditional-subtract behaviour.
   */
  async releaseReserve(
    account: string,
    amount: string,
    ref?: string,
  ): Promise<string> {
    return this.withLock(account, () => {
      const acct = this.ensureAccount(account);
      if (ref) {
        // O(1): only release when there is an outstanding hold for this ref.
        const net = acct.refCounters!.hold![ref] ?? 0;
        if (net <= 0) {
          return acct.sponsoredHeld;
        }
      }
      let next = toStroops(acct.sponsoredHeld) - toStroops(amount);
      if (next < 0n) next = 0n;
      acct.sponsoredHeld = fromStroops(next);
      acct.updatedAt = new Date().toISOString();
      if (ref) {
        this.bumpCounter(acct.refCounters!.hold!, ref, -1);
        this.pushHoldHistory(acct, {
          type: 'release',
          amount,
          ref,
          at: acct.updatedAt,
        });
      }
      this.persist();
      return acct.sponsoredHeld;
    });
  }
}
