import fs from 'fs';
import path from 'path';

/** One movement in an account's credit history. */
export interface LedgerHistoryEntry {
  type: 'credit' | 'debit';
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
}

/** On-disk shape of the credit ledger. */
export interface LedgerData {
  version: 1;
  consumedTxs: Record<string, string>;
  accounts: Record<string, LedgerAccount>;
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
      return parsed;
    } catch {
      return { version: 1, consumedTxs: {}, accounts: {} };
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
   * balance would go negative.
   */
  debit(account: string, amount: string, ref: string): LedgerAccount {
    const acct = this.ensureAccount(account);
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
    return acct;
  }

  /** Whether an account has at least `amount` credit available. */
  hasSufficient(account: string, amount: string): boolean {
    const acct = this.data.accounts[account];
    if (!acct) return false;
    return toStroops(acct.balance) >= toStroops(amount);
  }
}
