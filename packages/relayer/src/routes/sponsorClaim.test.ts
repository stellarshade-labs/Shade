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
} from '@stellar/stellar-sdk';
import { CreditLedger } from '../ledger.js';
import { initContext, resetContext } from '../context.js';
import {
  handleSponsorClaimPrepare,
  handleSponsorClaimSubmit,
} from './sponsorClaim.js';

const ASSET = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const BALANCE_ID =
  '00000000178826fbfe339e1f5c53417c6fb2e7e3b0a4b6d3e2a3f0e1d2c3b4a5e6f70819';
const OTHER_BALANCE_ID =
  '00000000aa8826fbfe339e1f5c53417c6fb2e7e3b0a4b6d3e2a3f0e1d2c3b4a5e6f70819';

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

function mockServer(relayerKey: string, existing: string[] = []) {
  const submitTransaction = vi.fn(async () => ({ hash: 'CLAIM_TX' }));
  const loadAccount = vi.fn(async (addr: string) => {
    if (addr === relayerKey || existing.includes(addr)) {
      return { accountId: () => addr, sequenceNumber: () => '5' };
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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spclaim-'));
    ledger = new CreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    stealth = Keypair.random();
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('prepare builds the sponsorship sandwich (account missing)', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });

    const req = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimPrepare(req, res);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.xdr).toBe('string');

    const tx = new Transaction(res.body.xdr, Networks.STANDALONE);
    const opTypes = tx.operations.map((o) => o.type);
    expect(opTypes).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
    ]);
    expect(tx.source).toBe(relayer.publicKey());
  });

  it('prepare omits createAccount when the stealth account exists', async () => {
    const { server } = mockServer(relayer.publicKey(), [stealth.publicKey()]);
    initContext({ keypair: relayer, network: 'local', server, ledger });

    const req = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimPrepare(req, res);

    const tx = new Transaction(res.body.xdr, Networks.STANDALONE);
    expect(tx.operations.map((o) => o.type)).not.toContain('createAccount');
  });

  it('submit accepts a co-signed, unmodified tx and submits it', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });

    // Build the expected prepared tx, then have the stealth key co-sign it.
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.STANDALONE);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.txHash).toBe('CLAIM_TX');
    expect(submitTransaction).toHaveBeenCalledOnce();
  });

  it('submit rejects a co-signed tx whose balanceId was mutated', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });

    // Prepare against OTHER_BALANCE_ID, then claim to submit for BALANCE_ID.
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: OTHER_BALANCE_ID,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.STANDALONE);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('submit rejects a co-signed tx whose asset was mutated', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });

    const otherAsset =
      'DAI:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const prepReq = {
      body: {
        stealthAddress: stealth.publicKey(),
        asset: otherAsset,
        balanceId: BALANCE_ID,
      },
    } as Request;
    const prepRes = mockRes();
    await handleSponsorClaimPrepare(prepReq, prepRes);
    const tx = new Transaction(prepRes.body.xdr, Networks.STANDALONE);
    tx.sign(stealth);

    const req = {
      body: {
        xdr: tx.toEnvelope().toXDR('base64'),
        stealthAddress: stealth.publicKey(),
        asset: ASSET,
        balanceId: BALANCE_ID,
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
    initContext({ keypair: relayer, network: 'local', server, ledger });

    // A relayer-sourced tx with an unexpected op (plain payment).
    const source = new Account(relayer.publicKey(), '5');
    const tampered = new TransactionBuilder(source, {
      fee: '200',
      networkPassphrase: Networks.STANDALONE,
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
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
  });

  it('submit rejects a non-relayer-sourced tx', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });

    const source = new Account(stealth.publicKey(), '5');
    const foreign = new TransactionBuilder(source, {
      fee: '200',
      networkPassphrase: Networks.STANDALONE,
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
      },
    } as Request;
    const res = mockRes();
    await handleSponsorClaimSubmit(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('tampered');
  });
});
