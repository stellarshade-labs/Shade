import { describe, it, expect } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { StealthClient } from '../src/client.js';
import {
  ShadeError,
  MethodRequiredError,
  MethodNotEnabledError,
  MethodNotAvailableError,
  MinimumAmountError,
  ClaimAmountError,
  ClaimAmountRequiresNoMergeError,
  InvalidAmountError,
  SponsoredClaimMismatchError,
  WrongPasswordError,
  SessionIntegrityError,
  NoBalanceError,
  AnnouncementNotFoundError,
  StealthAccountNotFoundError,
  DestinationTrustlineError,
  FeePayerRequiredError,
  FeePayerAddressRequiredError,
  EntryArchivedRestoringError,
  ContractIdRequiredError,
  TransactionRetryableError,
  TransactionTimeoutError,
} from '../src/errors.js';
import { SppAdapter } from '../src/methods/spp.js';

// A structurally valid pool contract id — these tests never reach the network,
// but a pool-enabled client requires one (there is no built-in default).
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));

describe('send method resolution', () => {
  const keys = StealthClient.keygen();

  it('throws MethodRequiredError (a coded ShadeError) when no method is given', async () => {
    const client = new StealthClient({ network: 'testnet', contractId: CONTRACT_ID, methods: ['pool', 'account'] });
    const err = await client
      // @ts-expect-error deliberately omitting the (now required) opts
      .send(keys.metaAddress, 100, 'SXXX')
      .catch((e) => e);
    expect(err).toBeInstanceOf(MethodRequiredError);
    expect(err).toBeInstanceOf(ShadeError);
    expect((err as MethodRequiredError).code).toBe('method_required');
  });

  it("'auto' picks 'account' for native amount > 1 when account enabled", async () => {
    const client = new StealthClient({ network: 'testnet', contractId: CONTRACT_ID, methods: ['pool', 'account'] });
    // account adapter will fail at network I/O; we only assert it routed to account
    // by checking the rejection is NOT MethodNotEnabledError (would mean it fell
    // back to a disabled method) and NOT MinimumAmountError (amount 2 > 1 clears
    // the account minimum, so reaching that error would mean a routing bug).
    const err = await client
      .send(keys.metaAddress, 2, 'GARBAGE_SECRET', { method: 'auto' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MethodNotEnabledError);
    expect(err).not.toBeInstanceOf(MinimumAmountError);
  });

  it("'auto' picks 'pool' when amount <= 1", async () => {
    const client = new StealthClient({ network: 'testnet', contractId: CONTRACT_ID, methods: ['pool'] });
    // pool enabled, account not — auto with amount 1 must resolve to pool (enabled),
    // so it must NOT throw MethodNotEnabledError.
    const err = await client
      .send(keys.metaAddress, 1, 'GARBAGE_SECRET', { method: 'auto' })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(MethodNotEnabledError);
  });

  it("'auto' falls back to 'pool' when account not enabled even for amount > 1", async () => {
    const client = new StealthClient({ network: 'testnet', contractId: CONTRACT_ID, methods: ['pool'] });
    const err = await client
      .send(keys.metaAddress, 100, 'GARBAGE_SECRET', { method: 'auto' })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(MethodNotEnabledError);
  });

  it('throws MethodNotEnabledError for a disabled method', async () => {
    const client = new StealthClient({ network: 'testnet', contractId: CONTRACT_ID, methods: ['pool'] });
    await expect(
      client.send(keys.metaAddress, 100, 'SXXX', { method: 'account' }),
    ).rejects.toBeInstanceOf(MethodNotEnabledError);
  });
});

describe('spp adapter', () => {
  const keys = StealthClient.keygen();
  const adapter = new SppAdapter();

  it('send throws MethodNotAvailableError', async () => {
    await expect(
      adapter.send({ metaAddress: keys.metaAddress, amount: 5, senderSecret: 'S' }),
    ).rejects.toBeInstanceOf(MethodNotAvailableError);
  });

  it('scan throws MethodNotAvailableError', async () => {
    await expect(adapter.scan(keys)).rejects.toBeInstanceOf(
      MethodNotAvailableError,
    );
  });

  it('claim throws MethodNotAvailableError', async () => {
    await expect(
      adapter.claim(
        {
          stealthAddress: 'G',
          ephemeralPubKey: '00',
          token: 'native',
          amount: 1,
          amountStroops: '10000000',
          method: 'spp',
        },
        'GDEST',
        { keys },
      ),
    ).rejects.toBeInstanceOf(MethodNotAvailableError);
  });
});

describe('error codes: every SDK error extends ShadeError with a stable code', () => {
  const G = Keypair.random().publicKey();
  const cases: Array<[ShadeError, string]> = [
    [new MethodRequiredError(), 'method_required'],
    [new MethodNotEnabledError('account'), 'method_not_enabled'],
    [new MethodNotAvailableError('nope'), 'method_not_available'],
    [new MinimumAmountError(0.5), 'minimum_amount'],
    [new ClaimAmountError(5, 4), 'claim_amount_exceeds_max'],
    [new ClaimAmountRequiresNoMergeError(), 'claim_amount_requires_no_merge'],
    [new ClaimAmountRequiresNoMergeError('token'), 'claim_amount_requires_no_merge'],
    [new InvalidAmountError(NaN), 'invalid_amount'],
    [new SponsoredClaimMismatchError('detail'), 'sponsored_claim_mismatch'],
    [new WrongPasswordError(), 'wrong_password'],
    [new SessionIntegrityError('spend'), 'session_integrity'],
    [new NoBalanceError(), 'no_balance'],
    [new AnnouncementNotFoundError(), 'announcement_not_found'],
    [new StealthAccountNotFoundError(), 'stealth_account_not_found'],
    [new DestinationTrustlineError('no trustline'), 'destination_trustline'],
    [new FeePayerRequiredError(), 'fee_payer_required'],
    [new FeePayerAddressRequiredError(), 'fee_payer_address_required'],
    [new EntryArchivedRestoringError('cause'), 'entry_archived_restoring'],
    [new ContractIdRequiredError('testnet'), 'contract_id_required'],
    [new TransactionRetryableError('TRY_AGAIN_LATER'), 'transaction_retryable'],
    [new TransactionTimeoutError('HASH'), 'transaction_timeout'],
  ];

  it.each(cases.map(([err, code]) => [err.name, err, code]))(
    '%s carries its stable code',
    (_name, err, code) => {
      expect(err).toBeInstanceOf(ShadeError);
      expect(err).toBeInstanceOf(Error);
      expect((err as ShadeError).code).toBe(code);
      // name is preserved per class (not flattened to 'ShadeError').
      expect((err as ShadeError).name).not.toBe('ShadeError');
    },
  );

  it('fund-safety flags: retryable errors are distinguishable from timeouts', () => {
    expect(new TransactionRetryableError('X').retryable).toBe(true);
    const t = new TransactionTimeoutError(G);
    expect(t.retryable).toBe(false);
    expect(t.txHash).toBe(G);
  });
});
