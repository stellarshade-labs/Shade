import { describe, it, expect } from 'vitest';
import {
  Networks,
  Transaction,
  TransactionBuilder,
  Keypair,
  Account,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';
import { RelayerClient, challengeMessage } from '../src/relayer.js';
import type { FetchLike } from '../src/horizon.js';

const PASSPHRASE = Networks.TESTNET;

function buildInnerTx(): string {
  const kp = Keypair.random();
  const source = new Account(kp.publicKey(), '1');
  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(300)
    .build();
  tx.sign(kp);
  return tx.toEnvelope().toXDR('base64');
}

describe('/relay proof-of-control inner-tx binding', () => {
  it('signs the relayer challengeMessage bound to the inner-tx hash', async () => {
    const funding = Keypair.random();
    const xdr = buildInnerTx();
    const nonce = 'a'.repeat(64);
    let signedMessage: string | undefined;

    const fetchFn: FetchLike = (async (url: string) => {
      const u = String(url);
      if (u.includes('/credit/challenge')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ account: funding.publicKey(), nonce }),
        };
      }
      if (u.includes('/relay')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ txHash: 'deadbeef' }),
        };
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as FetchLike;

    const client = new RelayerClient('http://relayer.test', fetchFn, {
      fundingAccount: funding.publicKey(),
      fundingSigner: (message: string) => {
        signedMessage = message;
        return funding.sign(Buffer.from(message, 'utf8')).toString('base64');
      },
    });

    await client.relay(xdr, {
      authAmount: '0.0000200',
      networkPassphrase: PASSPHRASE,
    });

    const innerTxHash = new Transaction(xdr, PASSPHRASE)
      .hash()
      .toString('hex');
    const expected = challengeMessage(
      'relay',
      funding.publicKey(),
      nonce,
      '0.0000200',
      innerTxHash,
    );

    expect(signedMessage).toBe(expected);
    // The relayer's own challengeMessage (identical function) must reproduce it,
    // proving the byte-for-byte contract holds.
    expect(signedMessage).toContain(`:${innerTxHash}`);
  });

  it('a signature for inner tx A does not match the message for inner tx B', () => {
    const funding = Keypair.random().publicKey();
    const nonce = 'b'.repeat(64);
    const hashA = new Transaction(buildInnerTx(), PASSPHRASE)
      .hash()
      .toString('hex');
    const hashB = new Transaction(buildInnerTx(), PASSPHRASE)
      .hash()
      .toString('hex');

    const msgA = challengeMessage('relay', funding, nonce, '0.0000200', hashA);
    const msgB = challengeMessage('relay', funding, nonce, '0.0000200', hashB);

    expect(hashA).not.toBe(hashB);
    expect(msgA).not.toBe(msgB);
  });
});
