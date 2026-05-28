import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response } from 'express';
import { handleSponsor, initSponsorRoute } from './sponsor';
import { Keypair } from '@stellar/stellar-sdk';

const { mockServerInstance } = vi.hoisted(() => ({
  mockServerInstance: {
    loadAccount: vi.fn(),
    submitTransaction: vi.fn()
  }
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(function() { return mockServerInstance; })
    },
    TransactionBuilder: vi.fn().mockImplementation(function() {
      return {
        addOperation: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        build: vi.fn().mockReturnValue({
          sign: vi.fn()
        })
      };
    }),
    Operation: {
      beginSponsoringFutureReserves: vi.fn(),
      createAccount: vi.fn(),
      endSponsoringFutureReserves: vi.fn()
    }
  };
});

describe('handleSponsor', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();

    mockKeypair = Keypair.random();
    initSponsorRoute(mockKeypair);

    const validAddress = 'GDXLKEY5TR4IDEV7FZWYFG6MA6M24YDCX5HENQ7DTESBE233EHT6HHGK';

    mockReq = {
      body: {
        address: validAddress
      },
      requestId: 'test-request-id'
    } as any;

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
  });

  it('should sponsor a new account', async () => {
    mockServerInstance.loadAccount
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        sequenceNumber: vi.fn().mockReturnValue('100'),
        accountId: mockKeypair.publicKey()
      });

    mockServerInstance.submitTransaction.mockResolvedValue({
      hash: 'test-tx-hash',
      successful: true
    });

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.json).toHaveBeenCalledWith({
      txHash: 'test-tx-hash',
      success: true,
      sponsored: 'GDXLKEY5TR4IDEV7FZWYFG6MA6M24YDCX5HENQ7DTESBE233EHT6HHGK'
    });
  });

  it('should validate address format', async () => {
    mockReq.body!.address = 'invalid-address';

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid Stellar address format',
      expected: 'G... format (56 characters)'
    });
  });

  it('should handle missing address', async () => {
    mockReq.body = {};

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid Stellar address format',
      expected: 'G... format (56 characters)'
    });
  });

  it('should validate amount if provided', async () => {
    mockReq.body!.amount = 0.5;

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid amount',
      minimum: 1,
      maximum: 1000000
    });
  });

  it('should reject if account already exists', async () => {
    mockServerInstance.loadAccount.mockResolvedValue({});

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Account already exists'
    });
  });

  it('should handle transaction submission errors', async () => {
    mockServerInstance.loadAccount
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        sequenceNumber: vi.fn().mockReturnValue('100'),
        accountId: mockKeypair.publicKey()
      });

    mockServerInstance.submitTransaction.mockRejectedValue(new Error('Network error'));

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Network error'
    });
  });

  it('should handle transaction result codes', async () => {
    mockServerInstance.loadAccount
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        sequenceNumber: vi.fn().mockReturnValue('100'),
        accountId: mockKeypair.publicKey()
      });

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

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Transaction failed',
      codes: {
        transaction: 'tx_failed',
        operations: ['op_underfunded']
      },
      message: 'tx_failed'
    });
  });

  it('should validate amount upper limit', async () => {
    mockReq.body!.amount = 2000000;

    await handleSponsor(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid amount',
      minimum: 1,
      maximum: 1000000
    });
  });
});
