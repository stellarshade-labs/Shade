import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response } from 'express';
import { handleRelay } from './relay';
import { Keypair, Account, Transaction, Networks } from '@stellar/stellar-sdk';

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

describe('handleRelay', () => {
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

    // Create a mock transaction XDR
    const mockTx = new Transaction(
      'AAAAAgAAAABihN1PONFSlF5Y3lw0EQfdoqHgCXvAC7VqcHspbVOiIAAPQkAACMryAAAAMgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAGKE3U840VKUX" +
      'ljeXDQRB92ioeAJe8ALtWpweylltU6IgAAAAEAAAAAVLF0bqNJXzKP0IX7HvlyHQQ8M5x5P3U2spz5sZN0AAAAAAAAAAAExLQAAAAAAAAAAAW1ToiAAAAEAUtIkuKlQM0L" +
      '+HdjkpAPek3qNUfKVU23IKxoNFLvMBedVIdcCnGj5sBGDNUWI/OLrNVKK9ugUiDt49qTlLt8L',
      Networks.TESTNET
    );

    mockReq = {
      body: {
        transactionXDR: mockTx.toXDR()
      }
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
  });

  it('should relay a valid transaction', async () => {
    const mockAccount = new Account(mockKeypair.publicKey(), '100');
    mockServer.loadAccount.mockResolvedValue(mockAccount);

    const mockTxResponse = {
      hash: 'test-tx-hash',
      successful: true
    };
    mockServer.submitTransaction.mockResolvedValue(mockTxResponse);

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockServer.submitTransaction).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      txHash: 'test-tx-hash',
      message: 'Transaction relayed successfully'
    });
  });

  it('should validate transaction XDR', async () => {
    mockReq.body!.transactionXDR = 'invalid-xdr';

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid transaction XDR'
    });
    expect(mockServer.submitTransaction).not.toHaveBeenCalled();
  });

  it('should handle missing transaction XDR', async () => {
    mockReq.body = {};

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Missing required parameter: transactionXDR'
    });
  });

  it('should handle transaction submission errors', async () => {
    mockServer.submitTransaction.mockRejectedValue(new Error('Network error'));

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Failed to relay transaction'
    });
  });

  it('should handle insufficient fee errors', async () => {
    const feeError = new Error('Insufficient fee');
    feeError.name = 'BadRequestError';
    mockServer.submitTransaction.mockRejectedValue(feeError);

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Transaction fee too low'
    });
  });

  it('should handle malformed transaction', async () => {
    mockReq.body!.transactionXDR = 'AAAA'; // Too short to be valid

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid transaction XDR'
    });
  });

  it('should handle timeout errors', async () => {
    const timeoutError = new Error('Request timeout');
    timeoutError.name = 'TimeoutError';
    mockServer.submitTransaction.mockRejectedValue(timeoutError);

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(503);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Transaction submission timeout'
    });
  });

  it('should validate transaction is not expired', async () => {
    // Create an expired transaction
    const expiredTx = new Transaction(
      'AAAAAgAAAABihN1PONFSlF5Y3lw0EQfdoqHgCXvAC7VqcHspbVOiIAAPQkAACMryAAAAMgAAAAEAAAAAAAAAAAAAAABkYmVjAAAAAAAAAAAAAAAAAAAAAQAAAAEAAAA' +
      'AYoTdTzjRUpReWN5cNBEH3aKh4Al7wAu1anB7KW1ToiAAAAEAAAAAVLF0bqNJXzKP0IX7HvlyHQQ8M5x5P3U2spz5sZN0AAAAAAAAAAAExLQAAAAAAAAAAAW1ToiAAAAEAUtI' +
      'kuKlQM0L+HdjkpAPek3qNUfKVU23IKxoNFLvMBedVIdcCnGj5sBGDNUWI/OLrNVKK9ugUiDt49qTlLt8L',
      Networks.TESTNET
    );
    mockReq.body!.transactionXDR = expiredTx.toXDR();

    await handleRelay(
      mockReq as Request,
      mockRes as Response,
      mockServer,
      mockKeypair
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Transaction has expired'
    });
  });
});