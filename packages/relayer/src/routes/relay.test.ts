import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response } from 'express';
import { handleRelay, initRelayRoute } from './relay';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { resolveRequireCredit } from '../boot.js';
import { initContext, resetContext } from '../context.js';
import type { CreditLedger } from '../ledger.js';
import { JsonCreditLedger } from '../ledger.js';
import type { ChallengeStore } from '../utils/auth.js';
import { MemoryChallengeStore, challengeMessage } from '../utils/auth.js';

const { mockServerInstance, MockTransaction } = vi.hoisted(() => {
  const mockServerInstance = {
    loadAccount: vi.fn(),
    submitTransaction: vi.fn(),
    fetchBaseFee: vi.fn()
  };
  // A parsed inner tx that PASSES the abuse guards by default: 1 op, near-future
  // timebounds, no memo, and a stable network-scoped hash. Individual tests
  // override fields to exercise the op-count / timebounds / memo rejections.
  const MockTransaction = vi.fn().mockImplementation(function() {
    return {
      toXDR: vi.fn().mockReturnValue('mock-xdr'),
      operations: [{ type: 'payment' }],
      timeBounds: { maxTime: String(Math.floor(Date.now() / 1000) + 120) },
      memo: { type: 'none' },
      hash: vi.fn().mockReturnValue(Buffer.from('innertxhash')),
    };
  });
  return { mockServerInstance, MockTransaction };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(function() { return mockServerInstance; })
    },
    Transaction: MockTransaction,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      buildFeeBumpTransaction: vi.fn()
    }
  };
});

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

describe('handleRelay', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();

    mockKeypair = Keypair.random();
    initRelayRoute(mockKeypair);
    initContext({
      keypair: mockKeypair,
      network: 'testnet',
      server: mockServerInstance as any,
    });

    mockReq = {
      body: {
        xdr: 'AAAAAgAAAABihN1PONFSlF5Y3lw0EQfdoqHgCXvAC7VqcHspbVOiIAAPQkAACMryAAAAMgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAGKE3U840VKUXljeXDQRB92ioeAJe8ALtWpweylltU6IgAAAAEAAAAAVLF0bqNJXzKP0IX7HvlyHQQ8M5x5P3U2spz5sZN0AAAAAAAAAAAExLQAAAAAAAAAAAW1ToiAAAAEAUtIkuKlQM0L+HdjkpAPek3qNUfKVU23IKxoNFLvMBedVIdcCnGj5sBGDNUWI/OLrNVKK9ugUiDt49qTlLt8L'
      }
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
  });

  afterEach(() => {
    resetContext();
  });

  it('should relay a valid transaction', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');

    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'test-tx-hash',
      successful: true
    });

    const mockFeeBumpTx = { sign: vi.fn() } as any;
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(mockFeeBumpTx);

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockServerInstance.submitTransaction).toHaveBeenCalledWith(mockFeeBumpTx);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      txHash: 'test-tx-hash'
    });
  });

  it('should validate transaction XDR', async () => {
    mockReq.body!.xdr = 'invalid-xdr';
    MockTransaction.mockImplementationOnce(function() { throw new Error('bad xdr'); });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid transaction XDR'
    });
  });

  it('should handle missing XDR', async () => {
    mockReq.body = {};

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Missing or invalid XDR'
    });
  });

  it('should handle transaction submission errors', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');

    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
    mockServerInstance.submitTransaction.mockRejectedValue(new Error('Network error'));

    const mockFeeBumpTx = { sign: vi.fn() } as any;
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(mockFeeBumpTx);

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Network error'
    });
  });

  it('should handle transaction result codes', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');

    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);

    const error: any = new Error('Transaction failed');
    error.response = {
      data: {
        extras: {
          result_codes: {
            transaction: 'tx_failed',
            operations: ['op_underfunded']
          }
        }
      }
    };
    mockServerInstance.submitTransaction.mockRejectedValue(error);

    const mockFeeBumpTx = { sign: vi.fn() } as any;
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(mockFeeBumpTx);

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Transaction failed',
      codes: {
        transaction: 'tx_failed',
        operations: ['op_underfunded']
      }
    });
  });

  it('should handle invalid XDR type', async () => {
    mockReq.body!.xdr = 123;

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Missing or invalid XDR'
    });
  });

  it('should handle uninitialized relayer', async () => {
    initRelayRoute(null as any);

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Relayer not initialized'
    });
  });
});

describe('handleRelay credit gating', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  let funder: Keypair;
  let fundingAccount: string;
  let challenges: ChallengeStore;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  const FEE_XLM = '0.0000600'; // 600 stroops built fee-bump fee.

  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-credit-'));
    ledger = new JsonCreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    funder = Keypair.random();
    fundingAccount = funder.publicKey();
    challenges = new MemoryChallengeStore();
    initRelayRoute(relayer, { ledger, requireCredit: true, challenges });
    initContext({
      keypair: relayer,
      network: 'testnet',
      server: mockServerInstance as any,
      ledger,
    });
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockReq = { body: { xdr: 'anything', fundingAccount } };
    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    initRelayRoute(Keypair.random());
  });

  /** A fee-bump tx mock carrying the full built outer fee + a stable hash. */
  function mockFeeBump(feeStroops: string) {
    return {
      fee: feeStroops,
      sign: vi.fn(),
      hash: vi.fn().mockReturnValue(Buffer.from('feebumphash')),
    } as any;
  }

  // Hex of the mock inner-tx hash (Buffer.from('innertxhash')), bound into the
  // /relay challenge so a signature is pinned to the specific inner tx.
  const INNER_TX_HASH = Buffer.from('innertxhash').toString('hex');

  /**
   * Produce a valid proof-of-control triple for the funder. The signed amount
   * is the client's fee CEILING and is echoed in the body as `authAmount`
   * (the route verifies the signature over it and enforces fee <= ceiling).
   */
  async function auth(amount: string): Promise<{
    nonce: string;
    signature: string;
    authAmount: string;
  }> {
    const nonce = await challenges.issue(fundingAccount);
    const msg = challengeMessage('relay', fundingAccount, nonce, amount, INNER_TX_HASH);
    const signature = funder.sign(Buffer.from(msg, 'utf8')).toString('base64');
    return { nonce, signature, authAmount: amount };
  }

  it('gates with 402 when the funding account has no credit', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    mockReq.body = { xdr: 'anything', fundingAccount, ...(await auth(FEE_XLM)) };

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('gates with 402 by default: requireCredit derived via resolveRequireCredit(undefined)', async () => {
    // The load-bearing default path: no RELAYER_REQUIRE_CREDIT env, so the
    // boot resolver must yield gating ON — and an uncredited /relay gets 402.
    const { requireCredit } = resolveRequireCredit(undefined);
    expect(requireCredit).toBe(true);
    initRelayRoute(relayer, { ledger, requireCredit, challenges });

    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    // No credit anywhere, no proof-of-control — the request must be refused.
    mockReq.body = { xdr: 'anything' };

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('debits the full built fee-bump fee (not a flat 200) on success', async () => {
    await ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    // Multi-op inner tx => outer fee 600 stroops = 0.00006 XLM.
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    // No result_xdr / fee_charged in the response: the reconciliation falls
    // back to settling the full built fee (the pre-reconciliation behavior).
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'RELAY_OK',
      successful: true,
    });
    mockReq.body = { xdr: 'anything', fundingAccount, ...(await auth(FEE_XLM)) };

    await handleRelay(mockReq as Request, mockRes as Response);

    // 10 - 0.00006 = 9.99994 (proves the full 600-stroop fee was debited,
    // not a flat 200-stroop / 0.00002 charge).
    expect(await ledger.getBalance(fundingAccount)).toBe('9.9999400');
  });

  it('reconciles the debit to the on-chain fee_charged from result_xdr', async () => {
    await ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    // Built (and reserved) 600 stroops, but the network only charged 400 —
    // the funder must end up debited exactly the on-chain fee_charged.
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'RELAY_OK',
      successful: true,
      result_xdr: resultXdrWithFee('400'),
    });
    mockReq.body = { xdr: 'anything', fundingAccount, ...(await auth(FEE_XLM)) };

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.json).toHaveBeenCalledWith({ txHash: 'RELAY_OK', success: true });
    expect(await ledger.getBalance(fundingAccount)).toBe('9.9999600');
  });

  it('never keeps more than the reserved fee when result_xdr reports a higher value', async () => {
    await ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    // fee_charged can never legitimately exceed the fee bid the reservation
    // covered; if a response claims it does, clamp to the reserved amount.
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'RELAY_OK',
      successful: true,
      result_xdr: resultXdrWithFee('900'),
    });
    mockReq.body = { xdr: 'anything', fundingAccount, ...(await auth(FEE_XLM)) };

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(await ledger.getBalance(fundingAccount)).toBe('9.9999400');
  });

  it('still returns success when settle throws after a landed submit', async () => {
    await ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'RELAY_OK',
      successful: true,
      result_xdr: resultXdrWithFee('400'),
    });
    vi.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('store down'));
    mockReq.body = { xdr: 'anything', fundingAccount, ...(await auth(FEE_XLM)) };

    await handleRelay(mockReq as Request, mockRes as Response);

    // The tx landed: the client must see success, not a 500 — and the
    // reservation must NOT be refunded (it stays OUTSTANDING for recovery).
    expect(mockRes.json).toHaveBeenCalledWith({ txHash: 'RELAY_OK', success: true });
    expect(await ledger.getBalance(fundingAccount)).toBe('9.9999400');
  });

  it('refunds the reservation when submit fails', async () => {
    await ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    mockServerInstance.submitTransaction.mockRejectedValue(
      new Error('Network error'),
    );
    mockReq.body = { xdr: 'anything', fundingAccount, ...(await auth(FEE_XLM)) };

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    // Credit restored after the failed submit.
    expect(await ledger.getBalance(fundingAccount)).toBe('10.0000000');
  });

  it('fails closed (500) when credit-gated without a challenge store — no debit', async () => {
    // A credit-gated relayer initialized WITHOUT a challenge store cannot prove
    // control of the fundingAccount, so it must refuse rather than debit an
    // attacker-named account with no signature check.
    await ledger.credit(fundingAccount, '10', 'DEP1');
    initRelayRoute(relayer, { ledger, requireCredit: true });
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
    // No credit was spent.
    expect(await ledger.getBalance(fundingAccount)).toBe('10.0000000');
  });
});

describe('handleRelay proof-of-control auth (credit-gated)', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  let funder: Keypair;
  let challenges: ChallengeStore;
  let mockRes: Partial<Response>;

  const FEE_XLM = '0.0000600'; // 600 stroops built fee-bump fee.

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auth-'));
    ledger = new JsonCreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    challenges = new MemoryChallengeStore();
    initRelayRoute(relayer, { ledger, requireCredit: true, challenges });
    initContext({
      keypair: relayer,
      network: 'testnet',
      server: mockServerInstance as any,
      ledger,
    });
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    initRelayRoute(Keypair.random());
  });

  function mockFeeBump(feeStroops: string) {
    return {
      fee: feeStroops,
      sign: vi.fn(),
      hash: vi.fn().mockReturnValue(Buffer.from('feebumphash')),
    } as any;
  }

  const INNER_TX_HASH = Buffer.from('innertxhash').toString('hex');

  async function auth(endpoint: string, signer: Keypair, amount: string, forNonceOf?: string) {
    const nonce = await challenges.issue(forNonceOf ?? funder.publicKey());
    const msg = challengeMessage(endpoint, funder.publicKey(), nonce, amount, INNER_TX_HASH);
    const signature = signer.sign(Buffer.from(msg, 'utf8')).toString('base64');
    return { nonce, signature, authAmount: amount };
  }

  async function callWith(body: Record<string, unknown>) {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'RELAY_OK',
      successful: true,
    });
    const req = {
      body: { xdr: 'anything', fundingAccount: funder.publicKey(), ...body },
    } as Request;
    await handleRelay(req, mockRes as Response);
  }

  it('accepts a request with a valid signed nonce', async () => {
    await callWith(await auth('relay', funder, FEE_XLM));
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      txHash: 'RELAY_OK',
    });
    expect(await ledger.getBalance(funder.publicKey())).toBe('9.9999400');
  });

  it('rejects a missing signature with 401', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    const nonce = await challenges.issue(funder.publicKey());
    const req = {
      body: { xdr: 'anything', fundingAccount: funder.publicKey(), nonce },
    } as Request;
    await handleRelay(req, mockRes as Response);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects a signature from the wrong signer with 401', async () => {
    const attacker = Keypair.random();
    await callWith(await auth('relay', attacker, FEE_XLM));
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects a reused nonce with 401', async () => {
    const a = await auth('relay', funder, FEE_XLM);
    await callWith(a);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      txHash: 'RELAY_OK',
    });
    // Replay the same nonce/signature.
    const mockRes2: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    const req = {
      body: { xdr: 'anything', fundingAccount: funder.publicKey(), ...a },
    } as Request;
    await handleRelay(req, mockRes2 as Response);
    expect(mockRes2.status).toHaveBeenCalledWith(401);
  });

  it('rejects an expired nonce with 401', async () => {
    const expiring = new MemoryChallengeStore(0);
    initRelayRoute(relayer, {
      ledger,
      requireCredit: true,
      challenges: expiring,
    });
    const nonce = await expiring.issue(funder.publicKey());
    const msg = challengeMessage('relay', funder.publicKey(), nonce, FEE_XLM, INNER_TX_HASH);
    const signature = funder.sign(Buffer.from(msg, 'utf8')).toString('base64');
    await callWith({ nonce, signature, authAmount: FEE_XLM });
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });
});

describe('handleRelay abuse guards (default free path)', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Explicitly ungated config (RELAYER_REQUIRE_CREDIT=0 equivalent): NO
    // credit gating, NO challenge store — only the abuse guards protect the
    // hot wallet here.
    const relayer = Keypair.random();
    initRelayRoute(relayer);
    initContext({
      keypair: relayer,
      network: 'testnet',
      server: mockServerInstance as any,
    });
    mockReq = { body: { xdr: 'anything' } };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue({
      fee: '600',
      sign: vi.fn(),
      hash: vi.fn().mockReturnValue(Buffer.from('feebumphash')),
    });
  });

  afterEach(() => {
    resetContext();
    initRelayRoute(Keypair.random());
  });

  const future = () => String(Math.floor(Date.now() / 1000) + 120);

  it('rejects an inner tx with too many operations', async () => {
    MockTransaction.mockImplementationOnce(function () {
      return {
        operations: new Array(100).fill({ type: 'payment' }),
        timeBounds: { maxTime: future() },
        memo: { type: 'none' },
        hash: vi.fn().mockReturnValue(Buffer.from('h')),
      };
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'too_many_ops' }),
    );
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an inner tx with absent timebounds', async () => {
    MockTransaction.mockImplementationOnce(function () {
      return {
        operations: [{ type: 'payment' }],
        timeBounds: undefined,
        memo: { type: 'none' },
        hash: vi.fn().mockReturnValue(Buffer.from('h')),
      };
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_timebounds' }),
    );
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an inner tx with far-future timebounds', async () => {
    MockTransaction.mockImplementationOnce(function () {
      return {
        operations: [{ type: 'payment' }],
        timeBounds: { maxTime: String(Math.floor(Date.now() / 1000) + 86_400) },
        memo: { type: 'none' },
        hash: vi.fn().mockReturnValue(Buffer.from('h')),
      };
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_timebounds' }),
    );
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an inner tx carrying a memo', async () => {
    MockTransaction.mockImplementationOnce(function () {
      return {
        operations: [{ type: 'payment' }],
        timeBounds: { maxTime: future() },
        memo: { type: 'text', value: 'hi' },
        hash: vi.fn().mockReturnValue(Buffer.from('h')),
      };
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'memo_not_allowed' }),
    );
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an outer fee above the XLM cap', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    // 2_000_000 stroops = 0.2 XLM, above the 0.1 default cap.
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue({
      fee: '2000000',
      sign: vi.fn(),
      hash: vi.fn().mockReturnValue(Buffer.from('feebumphash')),
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'fee_exceeds_cap' }),
    );
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('accepts a well-formed inner tx on the free path', async () => {
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'FREE_OK',
      successful: true,
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.json).toHaveBeenCalledWith({ success: true, txHash: 'FREE_OK' });
  });
});

describe('handleRelay inner-tx binding (credit-gated)', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  let funder: Keypair;
  let challenges: ChallengeStore;
  let mockRes: Partial<Response>;

  const FEE_XLM = '0.0000600';
  const HASH_A = Buffer.from('innertxhash').toString('hex'); // what the mock returns

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bind-'));
    ledger = new JsonCreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    challenges = new MemoryChallengeStore();
    initRelayRoute(relayer, { ledger, requireCredit: true, challenges });
    initContext({
      keypair: relayer,
      network: 'testnet',
      server: mockServerInstance as any,
      ledger,
    });
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'OK',
      successful: true,
    });
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue({
      fee: '600',
      sign: vi.fn(),
      hash: vi.fn().mockReturnValue(Buffer.from('feebumphash')),
    });
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    initRelayRoute(Keypair.random());
  });

  it('rejects a signature issued for inner tx A submitted with inner tx B', async () => {
    // Sign for a DIFFERENT inner-tx hash (tx "B") than the one the mock parses
    // (tx "A"). The binding must reject the mismatch.
    const HASH_B = Buffer.from('other-inner-tx').toString('hex');
    expect(HASH_B).not.toBe(HASH_A);
    const nonce = await challenges.issue(funder.publicKey());
    const msg = challengeMessage('relay', funder.publicKey(), nonce, FEE_XLM, HASH_B);
    const signature = funder.sign(Buffer.from(msg, 'utf8')).toString('base64');

    await handleRelay(
      {
        body: {
          xdr: 'anything',
          fundingAccount: funder.publicKey(),
          nonce,
          signature,
          authAmount: FEE_XLM,
        },
      } as Request,
      mockRes as Response,
    );

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('accepts a signature bound to the actual inner tx hash', async () => {
    const nonce = await challenges.issue(funder.publicKey());
    const msg = challengeMessage('relay', funder.publicKey(), nonce, FEE_XLM, HASH_A);
    const signature = funder.sign(Buffer.from(msg, 'utf8')).toString('base64');

    await handleRelay(
      {
        body: {
          xdr: 'anything',
          fundingAccount: funder.publicKey(),
          nonce,
          signature,
          authAmount: FEE_XLM,
        },
      } as Request,
      mockRes as Response,
    );

    expect(mockRes.json).toHaveBeenCalledWith({ success: true, txHash: 'OK' });
  });

  it('rejects when the built fee exceeds the signed authorization ceiling', async () => {
    // Signed ceiling is below the built fee (FEE_XLM=0.0000600 built vs a tiny
    // authorized ceiling): the relayer must refuse rather than overcharge.
    const nonce = await challenges.issue(funder.publicKey());
    const tinyCeiling = '0.0000001';
    const msg = challengeMessage('relay', funder.publicKey(), nonce, tinyCeiling, HASH_A);
    const signature = funder.sign(Buffer.from(msg, 'utf8')).toString('base64');

    await handleRelay(
      {
        body: {
          xdr: 'anything',
          fundingAccount: funder.publicKey(),
          nonce,
          signature,
          authAmount: tinyCeiling,
        },
      } as Request,
      mockRes as Response,
    );

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });
});
