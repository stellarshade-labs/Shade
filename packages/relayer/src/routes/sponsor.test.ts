import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response } from 'express';
import { handleSponsor } from './sponsor';
import { Keypair, Account, TransactionBuilder, Operation, Networks } from '@stellar/stellar-sdk';

// Mock Stellar SDK
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: vi.fn(),
        submitTransaction: vi.fn()
      }))
    }
  };
});

describe('handleSponsor', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockServer: any;
  let mockKeypair: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockKeypair = Keypair.random();

    mockServer = {
      loadAccount: vi.fn(),
      submitTransaction: vi.fn()
    };

    mockReq = {
      body: {
        stealthAddress: Keypair.random().publicKey(),
        amount: '10'
      }
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
  });

  it('should sponsor a valid stealth account', async () => {
    const mockAccount = new Account(mockKeypair.publicKey(), '100');
    mockServer.loadAccount.mockResolvedValue(mockAccount);

    const mockTxResponse = {
      hash: 'test-tx-hash',
      successful: true
    };
    mockServer.submitTransaction.mockResolvedValue(mockTxResponse);

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockServer.loadAccount).toHaveBeenCalledWith(mockKeypair.publicKey());
    expect(mockServer.submitTransaction).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      txHash: 'test-tx-hash',
      sponsor: mockKeypair.publicKey(),
      message: 'Account sponsored successfully'
    });
  });

  it('should validate stealth address format', async () => {
    mockReq.body!.stealthAddress = 'invalid-address';

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid stealth address format'
    });
    expect(mockServer.loadAccount).not.toHaveBeenCalled();
  });

  it('should validate amount', async () => {
    mockReq.body!.amount = '-10';

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid amount: must be positive'
    });
  });

  it('should handle missing parameters', async () => {
    mockReq.body = {};

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Missing required parameters: stealthAddress, amount'
    });
  });

  it('should handle account load errors', async () => {
    mockServer.loadAccount.mockRejectedValue(new Error('Account not found'));

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Failed to load sponsor account'
    });
  });

  it('should handle transaction submission errors', async () => {
    const mockAccount = new Account(mockKeypair.publicKey(), '100');
    mockServer.loadAccount.mockResolvedValue(mockAccount);
    mockServer.submitTransaction.mockRejectedValue(new Error('Transaction failed'));

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Failed to submit sponsorship transaction'
    });
  });

  it('should handle maximum amount limit', async () => {
    mockReq.body!.amount = '10000'; // Exceeds typical limit

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Amount exceeds maximum limit'
    });
  });

  it('should handle non-numeric amount', async () => {
    mockReq.body!.amount = 'abc';

    await handleSponsor(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid amount: must be a number'
    });
  });
});