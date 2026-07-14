import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import { randomBytes } from '@noble/hashes/utils';
import {
  Networks,
  Transaction,
  TransactionBuilder,
  Keypair,
  Memo,
  MemoHash,
  Account,
  Address,
  Asset,
  StrKey,
  hash,
  nativeToScVal,
  xdr,
  rpc,
  SorobanDataBuilder,
} from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import { PoolAdapter } from '../src/methods/pool.js';
import { HorizonClient, type FetchLike } from '../src/horizon.js';
import { FeePayerAddressRequiredError } from '../src/errors.js';
import type { StealthKeys, Payment, TransactionSigner } from '../src/types.js';

const NET = Networks.STANDALONE;

function makeKeys(): StealthKeys {
  const raw = generateMetaAddress();
  return {
    metaAddress: encodeMetaAddress(raw.metaAddress),
    spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
  };
}

/** A valid (constructible) contract id for the pool. */
function makeContractId(): string {
  const kp = Keypair.random();
  return StrKey.encodeContract(Buffer.from(hash(Buffer.from(kp.rawPublicKey()))));
}

/** Read the invoked contract function name from a simulation transaction. */
function invokedFunctionName(tx: Transaction): string {
  const op = tx.operations[0] as { func: xdr.HostFunction };
  return op.func.value().functionName().toString();
}

/**
 * A stub `rpc.Server` for the pool withdraw path. It answers the four read-only
 * simulations (`get_announcement_count`, `get_announcements`, `get_balance`,
 * `get_nonce`) with a single derived announcement that matches `keys`, and
 * captures the envelope handed to `sendTransaction`.
 */
function makePoolServer(opts: {
  keys: StealthKeys;
  tokenAddress: string;
  balanceStroops: bigint;
  feePayerAddress: string;
  submitted: Transaction[];
}): {
  server: rpc.Server;
  stealthAddress: string;
} {
  const spendPub = Buffer.from(opts.keys.spendPubKey, 'hex');
  const viewPub = Buffer.from(opts.keys.viewPubKey, 'hex');
  const ephemeralPrivKey = new Uint8Array(randomBytes(32));
  const stealth = deriveStealthAddressWithSecret(
    new Uint8Array(spendPub),
    new Uint8Array(viewPub),
    ephemeralPrivKey,
  );

  const announcementScVal = nativeToScVal({
    stealth_pk: Buffer.from(stealth.stealthPubKey),
    ephemeral_pk: Buffer.from(stealth.ephemeralPubKey),
    view_tag: nativeToScVal(stealth.viewTag, { type: 'u32' }),
    token: new Address(opts.tokenAddress),
    amount: nativeToScVal(opts.balanceStroops, { type: 'i128' }),
  });

  function simRetval(fn: string): xdr.ScVal {
    switch (fn) {
      case 'get_announcement_count':
        return nativeToScVal(1, { type: 'u64' });
      case 'get_announcements':
        return xdr.ScVal.scvVec([announcementScVal]);
      case 'get_balance':
        return nativeToScVal(opts.balanceStroops, { type: 'i128' });
      case 'get_nonce':
        return nativeToScVal(0, { type: 'u64' });
      default:
        throw new Error(`unexpected simulated fn: ${fn}`);
    }
  }

  const server = {
    async simulateTransaction(tx: Transaction): Promise<unknown> {
      const fn = invokedFunctionName(tx);
      // The withdraw invoke now flows through prepareWithRestore ->
      // rpc.assembleTransaction, which needs a parsed success simulation
      // (a real SorobanDataBuilder + result.auth), and NO restorePreamble so the
      // non-archived path assembles directly. The read-only queries only need a
      // retval.
      if (fn === 'withdraw') {
        return {
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: '100',
          result: { retval: xdr.ScVal.scvVoid(), auth: [] },
          events: [],
          latestLedger: 1,
        };
      }
      return { transactionData: {}, result: { retval: simRetval(fn) } };
    },
    async getAccount(address: string): Promise<Account> {
      return new Account(address, '100');
    },
    async sendTransaction(tx: Transaction): Promise<{ status: string; hash: string }> {
      opts.submitted.push(tx);
      return { status: 'SUCCESS', hash: 'POOL_WITHDRAW_HASH' };
    },
  } as unknown as rpc.Server;

  return { server, stealthAddress: stealth.stealthAddress };
}

function makeCapturingHorizon(opts: {
  accountsByAddress?: Record<string, unknown>;
  submitted: string[];
}): HorizonClient {
  const fetchFn: FetchLike = async (url, init) => {
    if (url.includes('/accounts/')) {
      const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
      const account = opts.accountsByAddress?.[address];
      if (!account) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => account };
    }
    if (url.endsWith('/transactions') && init?.method === 'POST') {
      const body = init.body ?? '';
      const xdr = decodeURIComponent(body.replace(/^tx=/, ''));
      opts.submitted.push(xdr);
      return { ok: true, status: 200, json: async () => ({ hash: 'SUBMITTED_HASH' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return new HorizonClient('http://localhost:8000', fetchFn);
}

afterEach(() => vi.unstubAllGlobals());

describe('external signing: account send routes the sender leg through the signer', () => {
  it('does NOT call Keypair.fromSecret for the sender and submits the signer output', async () => {
    const keys = makeKeys();
    // The real sender key: the signer knows the secret, the SDK only sees the G-address.
    const senderKeypair = Keypair.random();
    const senderAddress = senderKeypair.publicKey();

    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: {
        [senderAddress]: {
          id: senderAddress,
          sequence: '100',
          balances: [{ asset_type: 'native', balance: '1000.0000000' }],
        },
      },
      submitted,
    });

    // A UNIQUE memo the signer stamps onto its returned XDR, so we can prove the
    // submitted envelope is the SIGNER'S output rather than the SDK's original.
    const signerMemo = Memo.hash(Buffer.alloc(32, 7));
    const signerCalls: Array<{ xdr: string; address?: string; networkPassphrase: string }> = [];
    const signTransaction: TransactionSigner = async (xdr, o) => {
      signerCalls.push({ xdr, address: o.address, networkPassphrase: o.networkPassphrase });
      const tx = TransactionBuilder.fromXDR(xdr, o.networkPassphrase) as Transaction;
      const rebuilt = TransactionBuilder.cloneFrom(tx).addMemo(signerMemo).build();
      rebuilt.sign(senderKeypair);
      return rebuilt.toXDR();
    };

    // Spy Keypair.fromSecret: it must NOT be invoked with the sender secret path.
    const fromSecretSpy = vi.spyOn(Keypair, 'fromSecret');

    const adapter = new AccountAdapter(NET, horizon);
    await adapter.send({
      metaAddress: keys.metaAddress,
      amount: 5,
      senderSecret: senderAddress,
      signTransaction,
    });

    expect(signerCalls).toHaveLength(1);
    expect(signerCalls[0]!.address).toBe(senderAddress);
    expect(signerCalls[0]!.networkPassphrase).toBe(NET);
    expect(fromSecretSpy).not.toHaveBeenCalled();

    expect(submitted).toHaveLength(1);
    const submittedTx = new Transaction(submitted[0]!, NET);
    // The submitted envelope carries the signer's unique memo => it came from the
    // signer path, not from Keypair.fromSecret local signing.
    expect(submittedTx.memo.type).toBe(MemoHash);
    expect((submittedTx.memo.value as Buffer).equals(Buffer.alloc(32, 7))).toBe(true);
    fromSecretSpy.mockRestore();
  });
});

describe('external signing: pool claim requires feePayerAddress', () => {
  it('throws FeePayerAddressRequiredError when signTransaction is set but feePayerAddress is missing', async () => {
    const keys = makeKeys();
    // rpc server is never reached — the guard fires before any I/O.
    const server = {} as unknown as import('@stellar/stellar-sdk').rpc.Server;
    const adapter = new PoolAdapter('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGABAX', NET, server);

    const payment: Payment = {
      stealthAddress: Keypair.random().publicKey(),
      ephemeralPubKey: '00'.repeat(32),
      token: 'native',
      amount: 1,
      method: 'pool',
    };

    const signTransaction: TransactionSigner = async (xdr) => xdr;

    await expect(
      adapter.claim(payment, Keypair.random().publicKey(), {
        keys,
        signTransaction,
      }),
    ).rejects.toBeInstanceOf(FeePayerAddressRequiredError);
  });
});

describe('external signing: pool claim routes the fee-payer leg through the signer', () => {
  it('does NOT call Keypair.fromSecret for the fee payer and submits the signer output', async () => {
    const keys = makeKeys();
    // The real fee payer: the signer holds the secret, the SDK only sees the G-address.
    const feePayerKeypair = Keypair.random();
    const feePayerAddress = feePayerKeypair.publicKey();
    const destination = Keypair.random().publicKey();
    const contractId = makeContractId();
    const tokenAddress = Asset.native().contractId(NET);

    const submitted: Transaction[] = [];
    const { server, stealthAddress } = makePoolServer({
      keys,
      tokenAddress,
      balanceStroops: 50_000_000n,
      feePayerAddress,
      submitted,
    });

    // A UNIQUE memo the signer stamps onto its returned XDR, proving the
    // submitted envelope (rebuilt via signTx's fromXDR round-trip) is the
    // SIGNER'S output, and that the Soroban invoke op survived the round-trip.
    const signerMemo = Memo.hash(Buffer.alloc(32, 9));
    const signerCalls: Array<{ address?: string; networkPassphrase: string }> = [];
    const signTransaction: TransactionSigner = async (xdrStr, o) => {
      signerCalls.push({ address: o.address, networkPassphrase: o.networkPassphrase });
      const tx = TransactionBuilder.fromXDR(xdrStr, o.networkPassphrase) as Transaction;
      const rebuilt = TransactionBuilder.cloneFrom(tx).addMemo(signerMemo).build();
      rebuilt.sign(feePayerKeypair);
      return rebuilt.toXDR();
    };

    const fromSecretSpy = vi.spyOn(Keypair, 'fromSecret');

    const adapter = new PoolAdapter(contractId, NET, server);
    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: '00'.repeat(32),
      token: tokenAddress,
      amount: 5,
      method: 'pool',
    };

    const receipt = await adapter.claim(payment, destination, {
      keys,
      signTransaction,
      feePayerAddress,
    });

    expect(receipt.method).toBe('pool');
    expect(receipt.txHash).toBe('POOL_WITHDRAW_HASH');

    // The fee-payer leg went through the signer, keyed by its G-address.
    expect(signerCalls).toHaveLength(1);
    expect(signerCalls[0]!.address).toBe(feePayerAddress);
    expect(signerCalls[0]!.networkPassphrase).toBe(NET);
    // Keypair.fromSecret must never touch the fee payer G-address.
    expect(fromSecretSpy).not.toHaveBeenCalled();

    // The submitted envelope carries the signer's unique memo AND still holds the
    // Soroban invoke op => it came from the signer path via the fromXDR round-trip.
    expect(submitted).toHaveLength(1);
    const submittedTx = submitted[0]!;
    expect(submittedTx.memo.type).toBe(MemoHash);
    expect((submittedTx.memo.value as Buffer).equals(Buffer.alloc(32, 9))).toBe(true);
    expect(submittedTx.operations).toHaveLength(1);
    expect(submittedTx.operations[0]!.type).toBe('invokeHostFunction');

    fromSecretSpy.mockRestore();
  });
});

describe('external signing: absent signer preserves secret-based behavior', () => {
  it('calls Keypair.fromSecret when no signer is provided', async () => {
    const keys = makeKeys();
    const senderKeypair = Keypair.random();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: {
        [senderKeypair.publicKey()]: {
          id: senderKeypair.publicKey(),
          sequence: '100',
          balances: [{ asset_type: 'native', balance: '1000.0000000' }],
        },
      },
      submitted,
    });
    const fromSecretSpy = vi.spyOn(Keypair, 'fromSecret');
    const adapter = new AccountAdapter(NET, horizon);

    await adapter.send({
      metaAddress: keys.metaAddress,
      amount: 5,
      senderSecret: senderKeypair.secret(),
    });

    expect(fromSecretSpy).toHaveBeenCalledWith(senderKeypair.secret());
    expect(submitted).toHaveLength(1);
    fromSecretSpy.mockRestore();
  });
});
