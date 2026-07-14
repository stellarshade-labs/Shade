import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const assembleMock = vi.fn();

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
import { prepareWithRestore } from '../src/methods/restore.js';
import { EntryArchivedRestoringError } from '../src/errors.js';

const PASSPHRASE = Networks.TESTNET;

function makeInvocationTx(account?: StellarSdk.Account): StellarSdk.Transaction {
  const source = account ?? new Account(Keypair.random().publicKey(), '10');
  return new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: '0' }))
    .setTimeout(30)
    .build();
}

function makeSorobanData(): StellarSdk.SorobanDataBuilder {
  return new StellarSdk.SorobanDataBuilder();
}

/** A minimal SUCCESS simulation (no restore preamble). */
function successSim() {
  return {
    transactionData: makeSorobanData(),
    minResourceFee: '100',
  };
}

/** A SUCCESS-with-restorePreamble simulation (archived footprint). */
function restoreSim() {
  return {
    transactionData: makeSorobanData(),
    minResourceFee: '100',
    restorePreamble: {
      minResourceFee: '500',
      transactionData: makeSorobanData(),
    },
  };
}

describe('prepareWithRestore', () => {
  let assembledTx: StellarSdk.Transaction;

  beforeEach(() => {
    assembledTx = makeInvocationTx();
    assembleMock.mockReset();
    assembleMock.mockReturnValue({ build: () => assembledTx });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-archived: assembles the withdraw with NO restore submit', async () => {
    const tx = makeInvocationTx();
    const rebuild = vi.fn(() => makeInvocationTx());
    const server = {
      simulateTransaction: vi.fn().mockResolvedValue(successSim()),
      getAccount: vi.fn(),
    } as unknown as StellarSdk.rpc.Server;

    const order: string[] = [];
    const signRestore = vi.fn(async (t: StellarSdk.Transaction) => {
      order.push('sign');
      return t;
    });
    const submit = vi.fn(async () => {
      order.push('submit');
      return 'RESTORE_HASH';
    });

    const prepared = await prepareWithRestore(
      tx,
      rebuild,
      server,
      PASSPHRASE,
      signRestore,
      submit,
    );

    expect(prepared).toBe(assembledTx);
    // No restore path was taken.
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(signRestore).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    // Simulated exactly once (no re-simulate).
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(assembleMock).toHaveBeenCalledTimes(1);
    // The non-archived path assembles the passed-in tx untouched.
    expect(assembleMock.mock.calls[0][0]).toBe(tx);
  });

  it('archived: submits a RestoreFootprint BEFORE assembling the withdraw', async () => {
    const tx = makeInvocationTx();
    const feePayer = Keypair.random();
    const restoreAccount = new Account(feePayer.publicKey(), '20');

    const simulate = vi
      .fn()
      .mockResolvedValueOnce(restoreSim()) // first sim: archived
      .mockResolvedValueOnce(successSim()); // re-sim: clean
    const server = {
      simulateTransaction: simulate,
      getAccount: vi.fn().mockResolvedValue(restoreAccount),
    } as unknown as StellarSdk.rpc.Server;

    const rebuild = vi.fn((account: StellarSdk.Account) =>
      makeInvocationTx(account),
    );

    const order: string[] = [];
    let restoreOp: string | undefined;
    const signRestore = vi.fn(async (t: StellarSdk.Transaction) => {
      order.push('sign-restore');
      // The tx handed to the restore signer must be a RestoreFootprint op.
      restoreOp = (t.operations[0] as { type: string }).type;
      return t;
    });
    const submit = vi.fn(async () => {
      order.push('submit-restore');
      return 'RESTORE_HASH';
    });

    const notify = vi.fn();

    const prepared = await prepareWithRestore(
      tx,
      rebuild,
      server,
      PASSPHRASE,
      signRestore,
      submit,
      notify,
    );

    expect(prepared).toBe(assembledTx);
    // Restore was signed and submitted, in order, before assembly.
    expect(order).toEqual(['sign-restore', 'submit-restore']);
    expect(restoreOp).toBe('restoreFootprint');
    // getAccount: once for the restore build, once to rebuild the withdraw.
    expect(server.getAccount).toHaveBeenCalledTimes(2);
    // The invocation was rebuilt on a fresh account after the restore.
    expect(rebuild).toHaveBeenCalledTimes(1);
    // Simulated twice: archived, then re-simulated clean over the rebuilt tx.
    expect(simulate).toHaveBeenCalledTimes(2);
    // Assembled over the fresh (re-simulated) footprint.
    expect(assembleMock).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalled();
  });

  it('archived: rebuilds the withdraw on a strictly higher sequence than the restore (no txBAD_SEQ)', async () => {
    // The withdraw tx is built pre-restore at the fee payer's next sequence.
    // getAccount reflects on-chain consumption: it returns the current seq the
    // first time (for the restore build), then an advanced seq after the restore
    // is submitted (for the withdraw rebuild).
    const feePayer = Keypair.random();
    const startSeq = 100n;

    // Local mutable ledger sequence the mock advances on each restore submit.
    let ledgerSeq = startSeq;

    // The pre-restore withdraw, built at seq startSeq+1.
    const tx = makeInvocationTx(new Account(feePayer.publicKey(), String(startSeq)));

    // getAccount returns a fresh Account at the current ledger seq each call.
    const getAccount = vi.fn(
      async () => new Account(feePayer.publicKey(), String(ledgerSeq)),
    );

    const server = {
      simulateTransaction: vi
        .fn()
        .mockResolvedValueOnce(restoreSim())
        .mockResolvedValueOnce(successSim()),
      getAccount,
    } as unknown as StellarSdk.rpc.Server;

    // Rebuild the invocation from the freshly-fetched account (mirrors pool.ts).
    const rebuild = vi.fn((account: StellarSdk.Account) =>
      makeInvocationTx(account),
    );

    // assembleTransaction returns the tx it was handed so the assembled withdraw
    // preserves the rebuilt sequence — exercising real sequence arithmetic.
    assembleMock.mockImplementation((t: StellarSdk.Transaction) => ({
      build: () => t,
    }));

    let restoreSeq: string | undefined;
    const signRestore = vi.fn(async (t: StellarSdk.Transaction) => t);
    const submit = vi.fn(async (t: StellarSdk.Transaction) => {
      // Capture the restore's sequence, then advance the on-chain seq as the
      // restore submit consumes it.
      restoreSeq = t.sequence;
      ledgerSeq = BigInt(t.sequence);
      return 'RESTORE_HASH';
    });

    const prepared = await prepareWithRestore(
      tx,
      rebuild,
      server,
      PASSPHRASE,
      signRestore,
      submit,
    );

    // The restore consumed startSeq+1; the rebuilt withdraw must sit strictly
    // above it (startSeq+2), never reusing the restore's sequence.
    expect(restoreSeq).toBe(String(startSeq + 1n));
    expect(BigInt(prepared.sequence)).toBeGreaterThan(BigInt(restoreSeq!));
    expect(prepared.sequence).toBe(String(startSeq + 2n));
    // And it is NOT the original pre-restore withdraw's sequence.
    expect(prepared.sequence).not.toBe(tx.sequence);
  });

  it('archived: fee-payer signs and the restore fee covers minResourceFee + base', async () => {
    const tx = makeInvocationTx();
    const feePayer = Keypair.random();
    const restoreAccount = new Account(feePayer.publicKey(), '20');

    const server = {
      simulateTransaction: vi
        .fn()
        .mockResolvedValueOnce(restoreSim())
        .mockResolvedValueOnce(successSim()),
      getAccount: vi.fn().mockResolvedValue(restoreAccount),
    } as unknown as StellarSdk.rpc.Server;

    const rebuild = vi.fn((account: StellarSdk.Account) =>
      makeInvocationTx(account),
    );

    let restoreFee: string | undefined;
    const signRestore = vi.fn(async (t: StellarSdk.Transaction) => {
      restoreFee = t.fee;
      return t;
    });
    const submit = vi.fn(async () => 'RESTORE_HASH');

    await prepareWithRestore(tx, rebuild, server, PASSPHRASE, signRestore, submit);

    // restorePreamble.minResourceFee (500) + BASE_FEE (100) = 600
    expect(restoreFee).toBe('600');
  });

  it('propagates a simulation ERROR (matches prepareTransaction semantics)', async () => {
    const tx = makeInvocationTx();
    const rebuild = vi.fn(() => makeInvocationTx());
    const server = {
      simulateTransaction: vi
        .fn()
        .mockResolvedValue({ error: 'boom sim failed' }),
      getAccount: vi.fn(),
    } as unknown as StellarSdk.rpc.Server;

    await expect(
      prepareWithRestore(
        tx,
        rebuild,
        server,
        PASSPHRASE,
        async (t) => t,
        async () => 'X',
      ),
    ).rejects.toThrow('boom sim failed');
  });

  it('throws EntryArchivedRestoringError when the restore submit fails', async () => {
    const tx = makeInvocationTx();
    const feePayer = Keypair.random();
    const restoreAccount = new Account(feePayer.publicKey(), '20');

    const server = {
      simulateTransaction: vi.fn().mockResolvedValue(restoreSim()),
      getAccount: vi.fn().mockResolvedValue(restoreAccount),
    } as unknown as StellarSdk.rpc.Server;

    const rebuild = vi.fn((account: StellarSdk.Account) =>
      makeInvocationTx(account),
    );
    const signRestore = vi.fn(async (t: StellarSdk.Transaction) => t);
    const submit = vi.fn(async () => {
      throw new Error('relay rejected restore');
    });

    await expect(
      prepareWithRestore(tx, rebuild, server, PASSPHRASE, signRestore, submit),
    ).rejects.toBeInstanceOf(EntryArchivedRestoringError);
  });

  it('throws EntryArchivedRestoringError when the entry is still archived after restore', async () => {
    const tx = makeInvocationTx();
    const feePayer = Keypair.random();
    const restoreAccount = new Account(feePayer.publicKey(), '20');

    const server = {
      // Both the first sim and the re-sim report archived.
      simulateTransaction: vi.fn().mockResolvedValue(restoreSim()),
      getAccount: vi.fn().mockResolvedValue(restoreAccount),
    } as unknown as StellarSdk.rpc.Server;

    const rebuild = vi.fn((account: StellarSdk.Account) =>
      makeInvocationTx(account),
    );
    const signRestore = vi.fn(async (t: StellarSdk.Transaction) => t);
    const submit = vi.fn(async () => 'RESTORE_HASH');

    await expect(
      prepareWithRestore(tx, rebuild, server, PASSPHRASE, signRestore, submit),
    ).rejects.toBeInstanceOf(EntryArchivedRestoringError);
  });
});
