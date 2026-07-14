import {
  Account,
  Transaction,
  TransactionBuilder,
  Operation,
  SorobanDataBuilder,
  BASE_FEE,
  rpc,
} from '@stellar/stellar-sdk';
import { EntryArchivedRestoringError } from '../errors.js';

/**
 * How to sign a transaction leg for the restore flow — either the fee-payer
 * secret / external signer already used by the withdraw, expressed as a single
 * async callback. The helper stays agnostic to local-vs-Freighter signing.
 */
export type RestoreSigner = (tx: Transaction) => Promise<Transaction>;

/**
 * How to submit a signed transaction — either directly to the RPC or fee-bumped
 * through the relayer, mirroring whatever the withdraw itself uses. Returns the
 * submitted transaction hash.
 */
export type RestoreSubmit = (tx: Transaction) => Promise<string>;

/**
 * Optional progress reporter (the CLI wires this to a spinner/log line; the SDK
 * leaves it undefined).
 */
export type RestoreNotify = (message: string) => void;

/**
 * Rebuild the invocation transaction (e.g. the withdraw) from a freshly-fetched
 * source account. Used ONLY on the restore branch: after the RestoreFootprint
 * consumes the source account's next sequence number, the invocation must be
 * rebuilt on the new sequence — reusing the original pre-restore transaction
 * would submit at an already-consumed sequence (`txBAD_SEQ`). The factory must
 * produce the exact same operation/fee/timeout as the original build so only the
 * sequence differs.
 */
export type RebuildInvocation = (account: Account) => Transaction;

/**
 * Prepare a Soroban invocation transaction for submission, transparently
 * restoring an archived persistent footprint first when required.
 *
 * `server.prepareTransaction` only throws on a simulation ERROR — it never
 * consults `sim.restorePreamble`. When a recipient's persistent Balance/Nonce
 * entry has archived (Soroban state expiration), simulation returns
 * SUCCESS-with-restorePreamble; the bare prepare then assembles the withdraw
 * over the archived footprint, which submits but fails on-chain while
 * `get_balance`/`scan` still show the funds — an opaque brick.
 *
 * This helper reproduces `prepareTransaction`'s behavior for the normal path
 * (simulate → assemble the passed-in `tx`) but, when
 * {@link rpc.Api.isSimulationRestore} is true, first builds and submits a
 * RestoreFootprint transaction from `sim.restorePreamble`, waits for it to
 * succeed, then — because the restore consumes the fee-payer's next sequence
 * number — **re-fetches the source account and rebuilds the invocation on the
 * fresh sequence** via {@link RebuildInvocation} before re-simulating and
 * assembling. This avoids a `txBAD_SEQ` collision between the restore and the
 * withdraw. The non-archived path is behaviorally identical to the original
 * `prepareTransaction` call (the passed-in `tx` is assembled untouched).
 *
 * @param tx - The unsigned Soroban invocation transaction (e.g. the withdraw),
 *   already built on the source account's current sequence. Used directly on the
 *   non-archived path.
 * @param rebuildTx - Rebuilds the invocation from a freshly-fetched source
 *   account; used only on the restore branch to obtain a non-colliding sequence.
 * @param server - The Soroban RPC server.
 * @param networkPassphrase - Network passphrase for building the restore tx.
 * @param signRestore - Signs the RestoreFootprint transaction (fee-payer leg).
 * @param submitRestore - Submits the signed RestoreFootprint transaction.
 * @param notify - Optional progress reporter.
 * @returns The assembled invocation transaction, ready to sign and submit.
 * @throws {EntryArchivedRestoringError} If the entry is archived and the
 *   restore transaction could not be completed.
 */
export async function prepareWithRestore(
  tx: Transaction,
  rebuildTx: RebuildInvocation,
  server: rpc.Server,
  networkPassphrase: string,
  signRestore: RestoreSigner,
  submitRestore: RestoreSubmit,
  notify?: RestoreNotify,
): Promise<Transaction> {
  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }

  if (rpc.Api.isSimulationRestore(sim)) {
    notify?.('Stealth entry archived, restoring before withdraw…');
    await runRestore(
      sim.restorePreamble,
      tx.source,
      server,
      networkPassphrase,
      signRestore,
      submitRestore,
    );
    // The restore consumed the source's next sequence number. Re-fetch the
    // account and rebuild the invocation on the fresh sequence so the withdraw
    // does not collide with the just-submitted restore (txBAD_SEQ).
    let rebuilt: Transaction;
    try {
      const freshAccount = await server.getAccount(tx.source);
      rebuilt = rebuildTx(freshAccount);
    } catch (err) {
      throw new EntryArchivedRestoringError((err as Error).message);
    }
    // Re-simulate over the freshly restored footprint.
    const fresh = await server.simulateTransaction(rebuilt);
    if (rpc.Api.isSimulationError(fresh)) {
      throw new EntryArchivedRestoringError(fresh.error);
    }
    if (rpc.Api.isSimulationRestore(fresh)) {
      throw new EntryArchivedRestoringError(
        'entry still archived after restore submitted',
      );
    }
    return rpc.assembleTransaction(rebuilt, fresh).build();
  }

  return rpc.assembleTransaction(tx, sim).build();
}

/**
 * Build, sign, submit and confirm a RestoreFootprint transaction from a
 * simulation's `restorePreamble`. Any failure is wrapped in
 * {@link EntryArchivedRestoringError} so the withdraw path surfaces a single,
 * actionable error type.
 */
async function runRestore(
  restorePreamble: { minResourceFee: string; transactionData: SorobanDataBuilder },
  source: string,
  server: rpc.Server,
  networkPassphrase: string,
  signRestore: RestoreSigner,
  submitRestore: RestoreSubmit,
): Promise<void> {
  try {
    const account = await server.getAccount(source);
    const fee = (
      BigInt(restorePreamble.minResourceFee) + BigInt(BASE_FEE)
    ).toString();

    const restoreTx = new TransactionBuilder(account, {
      fee,
      networkPassphrase,
    })
      .setSorobanData(restorePreamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(30)
      .build();

    const signed = await signRestore(restoreTx);
    await submitRestore(signed);
  } catch (err) {
    if (err instanceof EntryArchivedRestoringError) throw err;
    throw new EntryArchivedRestoringError((err as Error).message);
  }
}
