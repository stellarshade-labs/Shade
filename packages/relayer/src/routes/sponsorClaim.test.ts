import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response } from 'express';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
  Transaction,
  Asset,
  Memo,
  TimeoutInfinite,
  xdr,
} from '@stellar/stellar-sdk';
import { resolveRequireCredit } from '../boot.js';
import type { CreditLedger } from '../ledger.js';
import { JsonCreditLedger } from '../ledger.js';
import { initContext, resetContext, getContext } from '../context.js';
import { challengeMessage } from '../utils/auth.js';
import {
  handleSponsorClaimPrepare,
  handleSponsorClaimSubmit,
} from './sponsorClaim.js';

const ASSET = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ASSET_CODE = 'USDC';
const ASSET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const AMOUNT = '100.0000000';
const BALANCE_ID =
  '00000000178826fbfe339e1f5c53417c6fb2e7e3b0a4b6d3e2a3f0e1d2c3b4a5e6f70819';
const OTHER_BALANCE_ID =
  '00000000aa8826fbfe339e1f5c53417c6fb2e7e3b0a4b6d3e2a3f0e1d2c3b4a5e6f70819';

/**
 * Base64 TransactionResult whose top-level feeCharged is `feeCharged` stroops —
 * what a Horizon submit response carries in `result_xdr` and what the debit
 * reconciliation decodes.
 */
function resultXdrWithFee(feeCharged: string): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(feeCharged),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  }).toXDR('base64');
}

function mockRes(): Response & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function mockServer(
  relayerKey: string,
  existing: string[] = [],
  trustingDestinations: string[] = [],
) {
  const submitTransaction = vi.fn(async () => ({ hash: 'CLAIM_TX' }));
  const loadAccount = vi.fn(async (addr: string) => {
    if (trustingDestinations.includes(addr)) {
      return {
        accountId: () => addr,
        sequenceNumber: () => '5',
        balances: [
          { asset_type: 'credit_alphanum4', asset_code: ASSET_CODE, asset_issuer: ASSET_ISSUER, balance: '0' },
          // Also trusts DAI (same issuer) so the asset-mutation test can prepare.
          { asset_type: 'credit_alphanum4', asset_code: 'DAI', asset_issuer: ASSET_ISSUER, balance: '0' },
        ],
      };
    }
    if (addr === relayerKey || existing.includes(addr)) {
      return { accountId: () => addr, sequenceNumber: () => '5', balances: [] };
    }
    const err: any = new Error('not found');
    err.response = { status: 404 };
    throw err;
  });
  return { server: { loadAccount, submitTransaction } as any, submitTransaction };
}

describe('sponsor-claim routes', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  let stealth: Keypair;
  let destination: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spclaim-'));
    ledger = new JsonCreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    stealth = Keypair.random();
    destination = Keypair.random().publicKey();
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('prepare builds the sponsorship sandwich + payout (account missing)', async () => {
    const { server } = mockServer(relayer.publicKey(), [], [destination]);
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const req = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimPrepare(req, res);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.xdr).toBe('string');

    const tx = new Transaction(res.body.xdr, Networks.TESTNET);
    const opTypes = tx.operations.map((o) => o.type);
    expect(opTypes).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
      'payment',
    ]);
    // The payout Payment pays the destination the claimed amount from the stealth account.
    const payout = tx.operations[tx.operations.length - 1] as any;
    expect(payout.destination).toBe(destination);
    expect(payout.amount).toBe(AMOUNT);
    expect(payout.source).toBe(stealth.publicKey());
    expect(tx.source).toBe(relayer.publicKey());
  });

  it('prepare rejects when the destination does not trust the asset', async () => {
    const { server } = mockServer(relayer.publicKey()); // destination not trusting
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const req = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimPrepare(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('destination_no_trust');
  });

  it('prepare omits createAccount when the stealth account exists', async () => {
    const { server } = mockServer(
      relayer.publicKey(),
      [stealth.publicKey()],
      [destination],
    );
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const req = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimPrepare(req, res);

    const tx = new Transaction(res.body.xdr, Networks.TESTNET);
    expect(tx.operations.map((o) => o.type)).not.toContain('createAccount');
  });

  it('submit accepts a co-signed, unmodified tx and submits it', async () => {
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // Build the expected prepared tx, then have the stealth key co-sign it.
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.TESTNET);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.txHash).toBe('CLAIM_TX');
    expect(submitTransaction).toHaveBeenCalledOnce();
  });

  it('submit rejects a co-signed tx whose payout destination was mutated', async () => {
    const otherDest = Keypair.random().publicKey();
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination, otherDest],
    );
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // Prepare paying `otherDest`, then submit claiming it was for `destination`.
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination: otherDest,
        amount: AMOUNT,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.TESTNET);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a co-signed tx whose payout amount was mutated', async () => {
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: '50.0000000',
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.TESTNET);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a co-signed tx whose balanceId was mutated', async () => {
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // Prepare against OTHER_BALANCE_ID, then claim to submit for BALANCE_ID.
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: OTHER_BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.TESTNET);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a co-signed tx whose asset was mutated', async () => {
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const otherAsset =
      'DAI:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: otherAsset,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.TESTNET);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a tampered op list', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // A relayer-sourced tx with an unexpected op (plain payment).
    const source = new Account(relayer.publicKey(), '5');
    const tampered = new TransactionBuilder(source, {
      fee: '200',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: relayer.publicKey(),
          asset: (await import('@stellar/stellar-sdk')).Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(60)
      .build();

    const req = {
      body: {
        xdr: tampered.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
  });

  /**
   * Build a relayer-sourced tx with the exact expected sponsor-claim ops (so
   * opsMatch passes), letting the caller override fee / timeout / memo to
   * exercise the fee-cap, TTL, and memo guards independently of op-tampering.
   */
  function buildExpectedTx(opts: {
    fee?: string;
    timeout?: number;
    memo?: Memo;
  }) {
    const source = new Account(relayer.publicKey(), '5');
    const builder = new TransactionBuilder(source, {
      fee: opts.fee ?? '200',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: stealth.publicKey(),
        }),
      )
      .addOperation(
        Operation.createAccount({
          destination: stealth.publicKey(),
          startingBalance: '0',
        }),
      )
      .addOperation(
        Operation.changeTrust({
          asset: new Asset(
            'USDC',
            'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          ),
          source: stealth.publicKey(),
        }),
      )
      .addOperation(
        Operation.endSponsoringFutureReserves({ source: stealth.publicKey() }),
      )
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: BALANCE_ID,
          source: stealth.publicKey(),
        }),
      )
      .addOperation(
        Operation.payment({
          destination,
          asset: new Asset(ASSET_CODE, ASSET_ISSUER),
          amount: AMOUNT,
          source: stealth.publicKey(),
        }),
      );
    if (opts.memo) builder.addMemo(opts.memo);
    return builder.setTimeout(opts.timeout ?? 60).build();
  }

  it('submit rejects a tx whose fee exceeds the per-op cap', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // 5 ops * 200 = 1000 stroop cap; 5000 total (1000/op) is over.
    const tx = buildExpectedTx({ fee: '1000' });
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a tx whose timebounds exceed the TTL', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // A 1-hour timeout blows past the 60s prepare TTL.
    const tx = buildExpectedTx({ timeout: 3600 });
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a tx with no timebounds', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const tx = buildExpectedTx({ timeout: TimeoutInfinite });
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a tx carrying a memo', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const tx = buildExpectedTx({ memo: Memo.text('sneaky') });
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a non-relayer-sourced tx', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const source = new Account(stealth.publicKey(), '5');
    const foreign = new TransactionBuilder(source, {
      fee: '200',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: stealth.publicKey(),
        }),
      )
      .addOperation(
        Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
      )
      .setTimeout(60)
      .build();

    const req = {
      body: {
        xdr: foreign.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
  });
});

describe('sponsor-claim submit: credit-gated reserve accounting', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  let stealth: Keypair;
  let funder: Keypair;
  let destination: string;

  const RESERVE = '1.0000000';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spclaim-credit-'));
    ledger = new JsonCreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    stealth = Keypair.random();
    funder = Keypair.random();
    destination = Keypair.random().publicKey();
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** Prepare a real sponsor-claim tx, co-sign with the stealth key, return it. */
  async function preparedSigned() {
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.TESTNET);
    tx.sign(stealth);
    return tx;
  }

  function totalXlm(feeStroops: string): string {
    const feeXlm = Number(feeStroops) / 1e7;
    return (feeXlm + Number(RESERVE)).toFixed(7);
  }

  async function signAuth(total: string) {
    const nonce = await getContext().challenges.issue(funder.publicKey());
    const msg = challengeMessage(
      'sponsor-claim',
      funder.publicKey(),
      nonce,
      total,
    );
    const signature = funder
      .sign(Buffer.from(msg, 'utf8'))
      .toString('base64');
    return { fundingAccount: funder.publicKey(), nonce, signature };
  }

  it('debits reserve + fee against fundingAccount and increments sponsoredHeld', async () => {
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      requireCredit: true,
    });

    const tx = await preparedSigned();
    const total = totalXlm(tx.fee);
    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
        ...(await signAuth(total)),
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(200);
    expect(submitTransaction).toHaveBeenCalledOnce();
    // Reserve + fee were debited. The mocked submit response carries no
    // result_xdr, so reconciliation falls back to the full declared fee; the
    // reserve is tracked in sponsoredHeld.
    const expectedBal = (10 - Number(total)).toFixed(7);
    expect(await ledger.getBalance(funder.publicKey())).toBe(expectedBal);
    expect((await ledger.getAccount(funder.publicKey()))?.sponsoredHeld).toBe(RESERVE);
  });

  it('reconciles the fee portion to fee_charged and keeps the full reserve', async () => {
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    // The network charged 500 stroops although the tx declared more: the
    // funder must end up debited fee_charged + the full sponsored reserve.
    submitTransaction.mockResolvedValue({
      hash: 'CLAIM_TX',
      result_xdr: resultXdrWithFee('500'),
    } as any);
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      requireCredit: true,
    });

    const tx = await preparedSigned();
    const total = totalXlm(tx.fee);
    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
        ...(await signAuth(total)),
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(200);
    // 10 - (0.0000500 fee_charged + 1.0000000 reserve) = 8.9999500 — the
    // declared-fee overhead was credited back, the reserve stayed charged.
    expect(await ledger.getBalance(funder.publicKey())).toBe('8.9999500');
    expect((await ledger.getAccount(funder.publicKey()))?.sponsoredHeld).toBe(RESERVE);
  });

  it('still returns 200 when settle throws after a landed submit', async () => {
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server } = mockServer(relayer.publicKey(), [], [destination]);
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      requireCredit: true,
    });

    const tx = await preparedSigned();
    const total = totalXlm(tx.fee);
    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
        ...(await signAuth(total)),
      },
    } as Request;
    vi.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('store down'));
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    // The claim landed on-chain: the client must see success — and the fee
    // must NOT be refunded nor the sponsored hold released (the old shape did
    // both, treating a settle failure as a failed submit).
    expect(res.statusCode).toBe(200);
    expect(res.body.txHash).toBe('CLAIM_TX');
    const expectedBal = (10 - Number(total)).toFixed(7);
    expect(await ledger.getBalance(funder.publicKey())).toBe(expectedBal);
    expect((await ledger.getAccount(funder.publicKey()))?.sponsoredHeld).toBe(RESERVE);
  });

  it('rejects an unauthenticated (no signature) request with 401', async () => {
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      requireCredit: true,
    });

    const tx = await preparedSigned();
    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
        fundingAccount: funder.publicKey(),
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(401);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('gates submit with 402 by default: requireCredit derived via resolveRequireCredit(undefined)', async () => {
    // The load-bearing default path: no RELAYER_REQUIRE_CREDIT env, so the
    // boot resolver must yield gating ON — and a submit backed by zero credit
    // gets 402 before anything is signed or submitted.
    const { requireCredit } = resolveRequireCredit(undefined);
    expect(requireCredit).toBe(true);

    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      requireCredit,
    });

    // NOTE: no ledger.credit(...) anywhere — the funder has no balance.
    const tx = await preparedSigned();
    const total = totalXlm(tx.fee);
    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
        ...(await signAuth(total)),
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe('insufficient_credit');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('returns 402 when the per-funder sponsored-reserve cap is exceeded', async () => {
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server, submitTransaction } = mockServer(
      relayer.publicKey(),
      [],
      [destination],
    );
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      requireCredit: true,
      // Cap below one reserve (1.0) so the very first hold trips it.
      sponsorClaimMaxHeld: 0.5,
    });

    const tx = await preparedSigned();
    const total = totalXlm(tx.fee);
    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
        destination,
        amount: AMOUNT,
        ...(await signAuth(total)),
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe('sponsored_held_exceeded');
    expect(submitTransaction).not.toHaveBeenCalled();
  });
});
