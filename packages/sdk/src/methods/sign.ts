import {
  Keypair,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { TransactionSigner } from '../types.js';

/**
 * Sign a transaction's sender / fee-payer leg, either locally with a secret or
 * by delegating to an external {@link TransactionSigner} (Freighter-style).
 *
 * When `signer` is set, `secretOrAddress` is treated as a PUBLIC G-address: the
 * unsigned XDR is handed to the signer and the returned signed XDR is rebuilt
 * into a {@link Transaction}. Rebuilding from the signer's output (rather than
 * mutating the input) preserves any Soroban footprint/auth the signed envelope
 * carries, which matters for the pool legs.
 *
 * When `signer` is absent, `secretOrAddress` is a Stellar secret and the
 * transaction is signed in place with `Keypair.fromSecret` — behavior identical
 * to the pre-signer code path.
 *
 * This helper is ONLY used for the sender / fee-payer legs. The stealth-key
 * legs sign with the recovered stealth scalar and never pass through here — a
 * wallet cannot hold that scalar.
 *
 * @param tx - The unsigned transaction to sign.
 * @param secretOrAddress - A Stellar secret (local signing) or, when `signer`
 *   is set, the G-address to sign with.
 * @param networkPassphrase - The network passphrase to sign/rebuild under.
 * @param signer - Optional external signer.
 * @returns The signed transaction.
 */
export async function signTx(
  tx: Transaction,
  secretOrAddress: string,
  networkPassphrase: string,
  signer?: TransactionSigner,
): Promise<Transaction> {
  if (signer) {
    const signed = await signer(tx.toXDR(), {
      networkPassphrase,
      address: secretOrAddress,
    });
    return TransactionBuilder.fromXDR(signed, networkPassphrase) as Transaction;
  }
  tx.sign(Keypair.fromSecret(secretOrAddress));
  return tx;
}
