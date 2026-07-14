import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const assembleMock = vi.fn();

// The CLI withdraw command assembles the (re-simulated) withdraw through the
// SDK's prepareWithRestore, which calls rpc.assembleTransaction. Mock only that
// leaf so the archived/non-archived branch logic runs for real against the real
// rpc.Api.isSimulation* guards.
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: (...args: unknown[]) => assembleMock(...args),
    },
  };
});

import * as StellarSdk from '@stellar/stellar-sdk';
import { Keypair, Account, TransactionBuilder, Networks } from '@stellar/stellar-sdk';
import { prepareWithRestore } from '@shade/sdk';

const PASSPHRASE = Networks.STANDALONE;

function makeTx(account?: StellarSdk.Account): StellarSdk.Transaction {
  const source = account ?? new Account(Keypair.random().publicKey(), '10');
  return new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: '0' }))
    .setTimeout(30)
    .build();
}

function sorobanData(): StellarSdk.SorobanDataBuilder {
  return new StellarSdk.SorobanDataBuilder();
}

function successSim() {
  return { transactionData: sorobanData(), minResourceFee: '100' };
}

function restoreSim() {
  return {
    transactionData: sorobanData(),
    minResourceFee: '100',
    restorePreamble: {
      minResourceFee: '700',
      transactionData: sorobanData(),
    },
  };
}

// Mirror the CLI withdraw closures: sign the fee-payer leg in place, submit
// directly to the RPC (the relay branch is exercised in the SDK suite).
function makeClosures(
  feePayer: Keypair,
  order: string[],
  submitHash: string,
) {
  const signLeg = (tx: StellarSdk.Transaction): Promise<StellarSdk.Transaction> => {
    tx.sign(feePayer);
    order.push('sign');
    return Promise.resolve(tx);
  };
  const submit = async (): Promise<string> => {
    order.push('submit');
    return submitHash;
  };
  return { signLeg, submit };
}

describe('CLI withdraw restore-before-withdraw', () => {
  let assembledTx: StellarSdk.Transaction;

  beforeEach(() => {
    assembledTx = makeTx();
    assembleMock.mockReset();
    assembleMock.mockReturnValue({ build: () => assembledTx });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-archived: submits the withdraw directly with no restore', async () => {
    const tx = makeTx();
    const feePayer = Keypair.random();
    const server = {
      simulateTransaction: vi.fn().mockResolvedValue(successSim()),
      getAccount: vi.fn(),
    } as unknown as StellarSdk.rpc.Server;

    const order: string[] = [];
    const { signLeg, submit } = makeClosures(feePayer, order, 'WITHDRAW_HASH');
    const rebuild = (account: StellarSdk.Account): StellarSdk.Transaction =>
      makeTx(account);

    const prepared = await prepareWithRestore(
      tx,
      rebuild,
      server,
      PASSPHRASE,
      signLeg,
      submit,
    );
    // CLI then signs + submits the prepared withdraw.
    await signLeg(prepared);
    const hash = await submit(prepared);

    expect(hash).toBe('WITHDRAW_HASH');
    expect(server.getAccount).not.toHaveBeenCalled();
    // No restore submit occurred: exactly one sign + one submit (the withdraw).
    expect(order).toEqual(['sign', 'submit']);
  });

  it('archived: submits RestoreFootprint BEFORE the withdraw submit', async () => {
    const tx = makeTx();
    const feePayer = Keypair.random();
    const restoreAccount = new Account(feePayer.publicKey(), '20');
    const server = {
      simulateTransaction: vi
        .fn()
        .mockResolvedValueOnce(restoreSim())
        .mockResolvedValueOnce(successSim()),
      getAccount: vi.fn().mockResolvedValue(restoreAccount),
    } as unknown as StellarSdk.rpc.Server;

    const order: string[] = [];
    let restoreOp: string | undefined;
    const submitted: StellarSdk.Transaction[] = [];
    const signLeg = (t: StellarSdk.Transaction): Promise<StellarSdk.Transaction> => {
      t.sign(feePayer);
      order.push('sign');
      return Promise.resolve(t);
    };
    const submit = async (t: StellarSdk.Transaction): Promise<string> => {
      submitted.push(t);
      restoreOp = restoreOp ?? (t.operations[0] as { type: string }).type;
      order.push('submit');
      return submitted.length === 1 ? 'RESTORE_HASH' : 'WITHDRAW_HASH';
    };
    const notify = vi.fn();
    const rebuild = (account: StellarSdk.Account): StellarSdk.Transaction =>
      makeTx(account);

    const prepared = await prepareWithRestore(
      tx,
      rebuild,
      server,
      PASSPHRASE,
      signLeg,
      submit,
      notify,
    );
    await signLeg(prepared);
    const hash = await submit(prepared);

    // First submit is the RestoreFootprint, second is the (rebuilt) withdraw.
    expect(restoreOp).toBe('restoreFootprint');
    expect((submitted[1].operations[0] as { type: string }).type).toBe(
      'bumpSequence',
    );
    expect(order).toEqual(['sign', 'submit', 'sign', 'submit']);
    expect(hash).toBe('WITHDRAW_HASH');
    // getAccount: once for the restore build, once to rebuild the withdraw.
    expect(server.getAccount).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalled();
  });
});
