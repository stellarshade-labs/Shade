# @shade/sdk

High-level client for **stealth payments on Stellar** (DKSAP on ed25519). Wraps the
`@shade/crypto` math and all Horizon/Soroban I/O behind a small `StealthClient`
with pluggable **delivery methods**. You never touch DKSAP math or transaction
serialization directly.

```bash
npm install @shade/sdk
```

## Quickstart

```typescript
import { StealthClient } from '@shade/sdk';

// `contractId` is REQUIRED whenever the pool method is enabled (mandatory on testnet
// — the constructor throws ContractIdRequiredError otherwise).
const client = new StealthClient({
  network: 'local',
  contractId: 'CXXX...',
  methods: ['pool', 'account'],
  relayer: 'http://localhost:3000', // optional
});

// Recipient keys (offline; share metaAddress publicly).
const bobKeys = StealthClient.keygen();

// Send. A delivery method is REQUIRED — 'pool' | 'account' | 'auto'. There is no
// implicit default; omitting it throws MethodRequiredError.
const receipt = await client.send(bobKeys.metaAddress, 100, aliceSecret, {
  method: 'auto',
});

// Scan (Payment[]). Use scanWithCursor(keys, { cursor }) for incremental rescans.
const payments = await client.scan(bobKeys);
// [{ stealthAddress, amount: 100, asset: 'XLM', method: 'pool', ... }]

// Claim a Payment to a real destination. `claim` branches on payment.method.
const result = await client.claim(payments[0], bobPublicKey, {
  keys: bobKeys,
  feePayer: feePayerSecret,          // pool claims need a fee payer for the Soroban fee
  relay: 'http://localhost:3000',    // optional fee-bump for privacy
});
```

## Delivery methods — pick per privacy / cost trade-off

`DeliveryMethod = 'pool' | 'account' | 'spp'`. All three use the same recipient
meta-address; they differ in where funds sit, discovery, and claim.

| | `pool` | `account` | `spp` |
| --- | --- | --- | --- |
| **Status** | Implemented | Implemented | Reserved (`MethodNotAvailableError`) |
| **Where funds sit** | Soroban pool contract, keyed by `(stealth_pk, token)` | One-time stealth account: native XLM as balance; tokens in a `ClaimableBalance` | ZK shielded pool (future) |
| **Sender↔recipient link** | Strong privacy: only touches the shared pool | Weaker: a `CreateAccount`/`CreateClaimableBalance` edge from sender to the one-time account | Strongest (planned) |
| **Amount** | On-chain per announcement | On-chain (starting balance / CB amount) | Hidden (planned) |
| **Minimum** | any `> 0` | native strictly `> 1 XLM`; token sender fronts ~1.5 XLM reserves (0.5 returns on claim) | N/A |
| **Assets** | any SAC token | native XLM or any SAC/classic asset | N/A |
| **Discovery** | contract announcements + view tag (~2x fast-scan) | `MemoHash(R)` on the funding tx via Horizon paging; destination match IS the verification | reserved |
| **Relayer** | optional fee-bump so the recipient needs no funded account | optional fee-bump / sponsored claim | N/A |

Rule of thumb: **`pool`** for best privacy + multi-token; **`account`** for the
simplest path that works with vanilla Horizon tooling; **`spp`** is a
forward-compatible slot (opt in later with zero API changes).

## Errors are typed

Public failures throw named subclasses of `Error` (all exported) so apps can branch:

```typescript
import { MethodRequiredError, ContractIdRequiredError, NoBalanceError,
         AnnouncementNotFoundError, StealthAccountNotFoundError,
         DestinationTrustlineError, FeePayerRequiredError,
         SponsoredClaimMismatchError } from '@shade/sdk';

try {
  await client.claim(payment, dest, { keys });
} catch (e) {
  if (e instanceof DestinationTrustlineError) { /* add a trustline first */ }
}
```

`SponsoredClaimMismatchError` is a **client-side safety control**: on a sponsored
token claim the SDK re-derives the relayer-prepared operation list from your own
inputs and refuses to sign if anything (payout destination/amount/asset, op source,
extra ops, memo) does not match — a malicious relayer cannot redirect the payout.

## Wallet-derived keys

`keysFromWalletSignature(signer, opts)` derives stealth keys from a wallet's
SEP-53 signature (keyless recovery). Determinism is verified by **default**
(`verifyDeterminism` defaults to `true`) so a randomized/non-canonical signer fails
loudly instead of deriving unrecoverable keys. Scope keys with a matching
`{ keyScope, appId }` across every tool that derives them (a mismatch yields
different, non-interoperable keys). Wallet compromise equals stealth-key compromise —
the accepted trade-off for keyless recovery.

## External signing (Freighter)

A dapp can let a browser wallet (Freighter) sign the **sender** and **fee-payer**
legs so it never handles a raw Stellar secret. Pass a `signTransaction` function
(Freighter's `signTransaction` shape) and, where a secret is normally expected,
pass the corresponding **public** `G...` address instead.

`TransactionSigner` returns the signed XDR **string**, so wallets whose API
returns an object (Freighter resolves to `{ signedTxXdr, signerAddress }`) must
**unwrap** it inside the adapter:

```typescript
import freighterApi from '@stellar/freighter-api';
import { StealthClient, type TransactionSigner } from '@shade/sdk';

const signTransaction: TransactionSigner = async (xdr, { networkPassphrase }) => {
  const { signedTxXdr } = await freighterApi.signTransaction(xdr, { networkPassphrase });
  return signedTxXdr;
};

const client = new StealthClient({ network: 'testnet', contractId: 'C...' });

// `senderSecret` positional carries the sender's G-ADDRESS when signing externally.
await client.send(metaAddress, 100, senderGAddress, {
  method: 'account',
  signTransaction,
});

// A pool claim needs a fee payer — supply its G-address (never a secret).
await client.claim(payment, destinationG, {
  keys,
  signTransaction,
  feePayerAddress: feePayerGAddress,
});
```

The recovered **stealth-key** claim/withdraw legs still sign **locally**: Freighter
cannot hold the derived stealth scalar, so `signTransaction` only ever applies to
the sender / fee-payer legs. Omitting `signTransaction` keeps the existing
secret-based behavior unchanged. Omitting `feePayerAddress` on a signed pool claim
throws `FeePayerAddressRequiredError` rather than treating a public key as a secret.
The CLI stays secret-based (no Freighter in the terminal).

## Roadmap / known limitations

Crypto is pending external audit (not for mainnet yet). The relayer's JSON credit
ledger and bearer-vs-signed funding-account auth, and Horizon full-scan without an
indexer, are scheduled hardening — see the repo root README.
