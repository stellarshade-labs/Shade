import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response } from 'express';
import { handleRelay, initRelayRoute } from './relay';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { CreditLedger } from '../ledger.js';

const { mockServerInstance, MockTransaction } = vi.hoisted(() => {
  const mockServerInstance = {
    loadAccount: vi.fn(),
    submitTransaction: vi.fn(),
    fetchBaseFee: vi.fn()
  };
  const MockTransaction = vi.fn().mockImplementation(function() {
    return { toXDR: vi.fn().mockReturnValue('mock-xdr') };
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

describe('handleRelay', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();

    mockKeypair = Keypair.random();
    initRelayRoute(mockKeypair);

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
  let fundingAccount: string;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-credit-'));
    ledger = new CreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
    fundingAccount = Keypair.random().publicKey();
    initRelayRoute(relayer, { ledger, requireCredit: true });
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockReq = { body: { xdr: 'anything', fundingAccount } };
    mockServerInstance.loadAccount.mockResolvedValue({});
    mockServerInstance.fetchBaseFee.mockResolvedValue(100);
  });

  afterEach(() => {
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

  it('gates with 402 when the funding account has no credit', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockServerInstance.submitTransaction).not.toHaveBeenCalled();
  });

  it('debits the full built fee-bump fee (not a flat 200) on success', async () => {
    ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    // Multi-op inner tx => outer fee 600 stroops = 0.00006 XLM.
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'RELAY_OK',
      successful: true,
    });

    await handleRelay(mockReq as Request, mockRes as Response);

    // 10 - 0.00006 = 9.99994 (proves the full 600-stroop fee was debited,
    // not a flat 200-stroop / 0.00002 charge).
    expect(ledger.getBalance(fundingAccount)).toBe('9.9999400');
  });

  it('refunds the reservation when submit fails', async () => {
    ledger.credit(fundingAccount, '10', 'DEP1');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    (TransactionBuilder.buildFeeBumpTransaction as any).mockReturnValue(
      mockFeeBump('600'),
    );
    mockServerInstance.submitTransaction.mockRejectedValue(
      new Error('Network error'),
    );

    await handleRelay(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    // Credit restored after the failed submit.
    expect(ledger.getBalance(fundingAccount)).toBe('10.0000000');
  });
});
