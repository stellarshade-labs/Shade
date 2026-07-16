import { describe, it, expect, vi } from 'vitest';
import {
  generateMetaAddress,
  encodeMetaAddress,
} from '@shade/crypto';
import {
  Networks,
  Keypair,
  Account,
  StrKey,
  hash,
  rpc,
  SorobanDataBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { PoolAdapter } from '../src/methods/pool.js';
import { waitForTransaction } from '../src/soroban.js';
import {
  TransactionRetryableError,
  TransactionTimeoutError,
} from '../src/errors.js';

const NET = Networks.STANDALONE;

function makeMetaAddress(): string {
  const raw = generateMetaAddress();
  return encodeMetaAddress(raw.metaAddress);
}

function makeContractId(): string {
  const kp = Keypair.random();
  return StrKey.encodeContract(Buffer.from(hash(Buffer.from(kp.rawPublicKey()))));
}

/**
 * A stub `rpc.Server` whose `sendTransaction` returns a caller-supplied status.
 * `prepareTransaction` echoes the built deposit tx and `getAccount` returns a
 * funded stub so the deposit reaches the submit branch.
 */
function makeServer(status: string, hashValue = 'DEPOSIT_HASH'): rpc.Server {
  return {
    async getAccount(address: string): Promise<Account> {
      return new Account(address, '100');
    },
    async prepareTransaction(tx: unknown): Promise<unknown> {
      return tx;
    },
    async sendTransaction(): Promise<{ status: string; hash: string }> {
      return { status, hash: hashValue };
    },
    async getTransaction(): Promise<{ status: string }> {
      return { status: 'SUCCESS' };
    },
    async simulateTransaction(): Promise<unknown> {
      return {
        _parsed: true,
        transactionData: new SorobanDataBuilder(),
        minResourceFee: '100',
        result: { retval: xdr.ScVal.scvVoid(), auth: [] },
        events: [],
        latestLedger: 1,
      };
    },
  } as unknown as rpc.Server;
}

describe('pool deposit: sendTransaction status handling (SDK-01)', () => {
  it('throws a retryable error on TRY_AGAIN_LATER instead of returning a receipt', async () => {
    const sender = Keypair.random();
    const adapter = new PoolAdapter(makeContractId(), NET, makeServer('TRY_AGAIN_LATER'));

    await expect(
      adapter.send({
        metaAddress: makeMetaAddress(),
        amount: 5,
        senderSecret: sender.secret(),
        asset: 'native',
      }),
    ).rejects.toBeInstanceOf(TransactionRetryableError);
  });

  it('returns the receipt on SUCCESS', async () => {
    const sender = Keypair.random();
    const adapter = new PoolAdapter(makeContractId(), NET, makeServer('SUCCESS'));

    const receipt = await adapter.send({
      metaAddress: makeMetaAddress(),
      amount: 5,
      senderSecret: sender.secret(),
      asset: 'native',
    });

    expect(receipt.txHash).toBe('DEPOSIT_HASH');
    expect(receipt.stealthAddress).toBeTruthy();
  });
});

describe('waitForTransaction: PENDING timeout is typed (double-send guard)', () => {
  it('throws TransactionTimeoutError carrying the tx hash, retryable=false', async () => {
    vi.useFakeTimers();
    try {
      // A tx that never reaches a terminal status within the polling window.
      const server = {
        async getTransaction(): Promise<{ status: string }> {
          return { status: 'NOT_FOUND' };
        },
      } as unknown as rpc.Server;

      // Capture the rejection up front so the pending promise never surfaces
      // as an unhandled rejection while the fake clock advances.
      const settled = waitForTransaction(server, 'STUCK_HASH').then(
        () => null,
        (e: unknown) => e,
      );
      // 30 polls x 1s sleep — advance past the whole confirmation window.
      await vi.advanceTimersByTimeAsync(31_000);
      const err = await settled;

      expect(err).toBeInstanceOf(TransactionTimeoutError);
      const timeout = err as TransactionTimeoutError;
      // The hash is what lets a caller poll to a terminal status instead of
      // blindly resubmitting (and double-sending) a tx that may still land.
      expect(timeout.txHash).toBe('STUCK_HASH');
      expect(timeout.retryable).toBe(false);
      expect(timeout.code).toBe('transaction_timeout');
      expect(timeout.message).toContain('STUCK_HASH');
    } finally {
      vi.useRealTimers();
    }
  });
});
