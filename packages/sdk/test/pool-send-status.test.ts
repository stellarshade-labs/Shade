import { describe, it, expect } from 'vitest';
import {
  generateMetaAddress,
  encodeMetaAddress,
} from '@shade/crypto';
import {
  Networks,
  Keypair,
  Account,
  Asset,
  StrKey,
  hash,
  rpc,
  SorobanDataBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { PoolAdapter } from '../src/methods/pool.js';
import { TransactionRetryableError } from '../src/errors.js';

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
