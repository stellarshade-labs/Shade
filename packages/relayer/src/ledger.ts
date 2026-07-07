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

/** Per-account credit bookkeeping. */
export interface LedgerAccount {
  balance: string;
  sponsoredHeld: string;
  updatedAt: string;
  history: LedgerHistoryEntry[];
  /** Sponsored-reserve hold/release history (refund-aware, mirrors `history`). */
  holdHistory?: HoldHistoryEntry[];
}

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
 * A durable, stroop-precision credit ledger backed by a single JSON file.
 *
 * All arithmetic is done on BigInt stroops (never floats), and writes are
 * atomic (write-tmp + rename) so a crash mid-write cannot corrupt the ledger.
 * Consumed deposit tx hashes are recorded to make credit claims idempotent.
 */
export class CreditLedger {
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
      };
      this.data.accounts[account] = acct;
    }
    return acct;
  }

  /** Whether a deposit tx hash has already been credited. */
  hasConsumed(txHash: string): boolean {
    return txHash in this.data.consumedTxs;
  }

  /** Current balance (decimal string) for an account, or null if unknown. */
  getBalance(account: string): string | null {
    return this.data.accounts[account]?.balance ?? null;
  }

  /** Full account record, or null if unknown. */
  getAccount(account: string): LedgerAccount | null {
    return this.data.accounts[account] ?? null;
  }

  /**
   * Credit an account from a verified deposit tx. Idempotent: a repeated
   * txHash throws so the caller can return 409.
   */
  credit(account: string, amount: string, txHash: string): LedgerAccount {
    if (this.hasConsumed(txHash)) {
      throw new Error('tx_already_claimed');
    }
    const acct = this.ensureAccount(account);
    const next = toStroops(acct.balance) + toStroops(amount);
    acct.balance = fromStroops(next);
    acct.updatedAt = new Date().toISOString();
    acct.history.push({
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
  debit(account: string, amount: string, ref: string): LedgerAccount {
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
    const refundRef = `refund:${ref}`;
    const debitCount = acct.history.filter(
      (h) => h.type === 'debit' && h.ref === ref,
    ).length;
    const refundCount = acct.history.filter(
      (h) => h.type === 'credit' && h.ref === refundRef,
    ).length;
    if (debitCount > refundCount) {
      return { acct, debited: false };
    }
    const remaining = toStroops(acct.balance) - toStroops(amount);
    if (remaining < 0n) {
      throw new Error('insufficient_credit');
    }
    acct.balance = fromStroops(remaining);
    acct.updatedAt = new Date().toISOString();
    acct.history.push({
      type: 'debit',
      amount,
      ref,
      at: acct.updatedAt,
    });
    this.persist();
    return { acct, debited: true };
  }

  /** Whether an account has at least `amount` credit available. */
  hasSufficient(account: string, amount: string): boolean {
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
   */
  async settle(reservation: Reservation): Promise<void> {
    await this.withLock(reservation.account, () => {
      const rec = this.data.reservations[reservation.id];
      if (!rec || rec.state !== 'OUTSTANDING') return;
      rec.state = 'SETTLED';
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
      const acct = this.data.accounts[rec.account];
      if (!acct) return;
      const next = toStroops(acct.balance) + toStroops(rec.amount);
      acct.balance = fromStroops(next);
      acct.updatedAt = new Date().toISOString();
      acct.history.push({
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
      if (!acct.holdHistory) acct.holdHistory = [];
      if (ref) {
        const holdCount = acct.holdHistory.filter(
          (h) => h.type === 'hold' && h.ref === ref,
        ).length;
        const releaseCount = acct.holdHistory.filter(
          (h) => h.type === 'release' && h.ref === ref,
        ).length;
        if (holdCount > releaseCount) {
          // An outstanding (not-yet-released) hold for this ref — no-op.
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
        acct.holdHistory.push({
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
      if (!acct.holdHistory) acct.holdHistory = [];
      if (ref) {
        const holdCount = acct.holdHistory.filter(
          (h) => h.type === 'hold' && h.ref === ref,
        ).length;
        const releaseCount = acct.holdHistory.filter(
          (h) => h.type === 'release' && h.ref === ref,
        ).length;
        if (holdCount <= releaseCount) {
          // No outstanding hold for this ref — nothing to release.
          return acct.sponsoredHeld;
        }
      }
      let next = toStroops(acct.sponsoredHeld) - toStroops(amount);
      if (next < 0n) next = 0n;
      acct.sponsoredHeld = fromStroops(next);
      acct.updatedAt = new Date().toISOString();
      if (ref) {
        acct.holdHistory.push({
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
