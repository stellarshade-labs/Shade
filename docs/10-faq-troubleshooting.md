---
title: FAQ & Troubleshooting
description: "Common Shade questions and an error-by-error guide: what each typed error means, why it fired, and how to fix it."
---

# Shade FAQ & Troubleshooting

Common questions, and an error-by-error guide to what went wrong and how to fix it.

---

## FAQ

### Is Shade a mixer?

**No.** Each stealth key has its own isolated balance in the pool contract, and both the deposit and the withdrawal name that same key on-chain. The *flow* of funds stays traceable. Shade hides **who** the recipient is, not that money moved.

### Can I send money directly to a meta-address?

No. A meta-address is not a Stellar account; it's just two public keys bundled together. Senders use it to *compute* a fresh one-time stealth address for each payment.

### Does the money go to my real account?

No. In the `pool` method funds sit in the contract, keyed by a one-time stealth public key derived from your meta-address. Your real address only appears when *you* choose it as a withdrawal destination. That's why it should be a fresh address, and why the relayer should pay the fee.

### Do I need a funded account to receive money?

For the `pool` method, **no**. You don't even need a Stellar account, since the contract authorizes withdrawals by signature. You do need *someone* to pay the Soroban fee: either your own fee-payer account, or a relayer fee-bump (the private option).

For the `account` method the one-time account is created and funded by the **sender** (~1 XLM base reserve, or ~1.5 XLM for tokens). You get the reserve back on a full `AccountMerge` sweep.

### Can I claim to a brand-new, empty address?

For a token claim, yes: use a relayer **sponsored claim** (`--sponsored`), where the relayer fronts the reserves and the token is paid to your destination in the same transaction. For a pool withdraw, the destination must already exist as a Stellar account.

### Is my keystore encrypted?

**Yes, by default** (AES-256-GCM). You only get a plaintext keystore if you explicitly pass `--plaintext` / `--no-encrypt`.

### Can I revoke a view key I shared?

**No.** There is no revocation. Generate new keys and publish a new meta-address. Note that old payments stay visible to the old viewer.

### Is this safe for mainnet?

**No.** The project has not had an external cryptographic audit. See [Security](./09-security.md).

### What is `spp`?

A reserved enum slot for a possible future integration with a separate, external private-payments effort. It is **not implemented** and not on Shade's roadmap: every call throws `MethodNotAvailableError`.

---

## Troubleshooting by error

### `MethodRequiredError`

> A delivery method is required. Pass `opts.method: 'pool' | 'account' | 'auto'`.

There is deliberately no implicit default; the privacy trade-off must be a conscious choice. Pass `method` (CLI: `--method`). Use `'auto'` to let the client pick.

### `ContractIdRequiredError`

The `pool` method is enabled but no contract id resolved. There is no built-in default on any network:

- **SDK:** pass `contractId: 'C...'` in `ClientConfig`.
- **CLI:** deploy the contract and write its id to `~/.stealth/<network>-contract`.

### `MethodNotEnabledError`

The method isn't in `config.methods`. Add it: `methods: ['pool', 'account']`.

### `MethodNotAvailableError`

Either you asked for `spp` (never implemented), or you called the deprecated `withdraw()` without the `pool` method enabled.

### `MinimumAmountError`

An account-method XLM send must be **strictly greater than 1 XLM**. Below that the new account can't meet its base reserve. Send more, or use `method: 'pool'`, which has no such floor.

### `ClaimAmountError`

A partial account claim asked for more than the account can pay out while keeping **2× the base reserve (1.0 XLM)** and covering the fee. The error carries `.max`. Retry within it, or do a full sweep (`merge: true` / drop `--no-merge`).

### `NoBalanceError`

The stealth address holds nothing in the pool **for that asset**. Either it was already withdrawn, or you're querying the wrong asset. Pass the right `--asset` / `opts.asset`.

### `AnnouncementNotFoundError`

No announcement matching that stealth address was found for your keys. Causes:

1. The payment isn't yours.
2. The deposit hasn't landed/indexed yet. Wait and rescan.

(`balance`, `withdraw` and `scan` all page the full announcement set, so a high announcement index is *not* a cause.)

### `StealthAccountNotFoundError`

The stealth account isn't on Horizon yet, usually because the funding send hasn't confirmed. Wait and retry.

### `DestinationTrustlineError`

The destination doesn't (or can't yet) trust the asset you're claiming. **Add the trustline on the destination account before claiming.** If the destination doesn't exist at all, fund it first.

### `FeePayerRequiredError`

A pool withdraw needs an account to pay the Soroban fee, and none was supplied. Pass `feePayer` (CLI: `--fee-payer`, or better `$SHADE_FEE_PAYER`), or route through a relayer with `--relay`.

### `FeePayerAddressRequiredError`

You set an external signer (`signTransaction`) on a pool claim but didn't pass `feePayerAddress`. With external signing the fee payer is identified by its **`G...` address**, never a secret. Pass `feePayerAddress`.

### `SponsoredClaimMismatchError`

**Take this seriously.** The relayer-prepared transaction does not match the operation list the SDK re-derived from your own inputs, so the SDK refused to sign. The message names the specific mismatch (a tampered payout destination, an extra appended operation, …). **The relayer may be malicious.** Don't retry blindly against the same relayer.

### `EntryArchivedRestoringError`

Your pool `Balance`/`Nonce` entry archived (Soroban state expiration) and the automatic `RestoreFootprintOp` failed. **Your funds are safe**; the withdraw just can't proceed until the entry is restored. The message carries the underlying cause; common ones are an unfunded fee payer or a relayer rejection. Fix that and retry.

Prevention: scan periodically. `get_balance`/`get_nonce` extend a live entry's TTL back to ~1 year on read, so a passively scanning recipient never archives.

### `TransactionRetryableError`

The RPC returned a non-terminal status (e.g. `TRY_AGAIN_LATER`), so **nothing landed on-chain**. Safe to retry with a fresh submission. The error carries `.retryable`.

### `WrongPasswordError` / "Keystore is encrypted but no password provided"

Wrong or missing keystore/session password. The CLI prompts on stderr if you omit `--password`; the SDK session throws on an AES-GCM authentication failure.

### "stdin closed before input was received"

A CLI prompt (keystore password, secret) hit end-of-file before any input arrived, typical with piped stdin or in CI. The command exits **1** with this message instead of node's old behaviour of silently exiting **0** mid-command as if it had succeeded. In non-interactive contexts, pass the value via its flag or environment variable (e.g. `--password`, `$SHADE_FEE_PAYER`).

### `SessionIntegrityError`

The public key stored in the clear doesn't match the one re-derived from the decrypted private key, so **the stored session may have been tampered with**. Don't trust the material; re-import your keys.

### `InvalidMetaAddress`

The meta-address failed prefix, length, hex, checksum, or on-curve/torsion validation. Check for a truncated or mistyped copy-paste.

---

## Common non-error problems

### "I scanned but see nothing"

- Check `--network` matches where the payment was sent.
- For the account method, the cursor is persisted, so a previous scan may have advanced past it. Try `--full-rescan`.
- With an indexer configured (`--indexer` / `SHADE_INDEXER`), a **cold** scan fast-starts at the indexer's coverage start. A payment older than the indexer's coverage is found only by `--full-rescan` (SDK: `ScanOpts.exhaustive`), which walks the pre-indexer history too.
- Confirm the sender used *your* meta-address (the checksum makes a corrupted one throw, but a wrong-but-valid one won't).
- Confirm the deposit transaction actually landed.

### "`balance` shows less than `scan` found"

Expected in one case: `balance` suppresses fully-swept native accounts (live balance 0). For pool announcements the two commands can't diverge, because `balance` reuses `scan`'s paged fetch and pages the full set.

### "My withdraw signature is rejected by the contract"

Almost always the raw-scalar footgun: you built a keypair from `recoverStealthPrivateKey`'s output via `Keypair.fromRawEd25519Seed()` (or similar), which hashes it into a *different* key. **Sign with `signWithStealthKey`.** See [Core Concepts](./02-core-concepts.md#the-math).

Otherwise: check the contract id and network passphrase. The message binds both, so a signature built for one deployment/network is rejected on another.

### "The relayer returns 402 `insufficient_credit`"

The relayer requires credit. Gating is on by default; an operator turns it off with `RELAYER_REQUIRE_CREDIT=0`. Top up via `POST /credit/claim` with the hash of an XLM payment to the relayer, and pass `fundingAccount` (CLI: `--funding-account`) on your requests.

### "The relayer returns 401"

The proof-of-control challenge failed: an expired/unknown nonce (120-second TTL, single-use), an account mismatch, a signature that doesn't verify, or an `authAmount` that doesn't equal what the relayer will charge. On `/relay` the signature also binds the **inner-tx hash** and the network passphrase; a mismatch there fails too. Fetch a fresh nonce and re-sign.

### "The relayer returns 429"

Rate limit: 10 requests/minute per client. Back off (`Retry-After` is set).

### "My keys don't match between the CLI and the SDK"

`appId` and `keyScope` must match across every tool. Defaults are `appId = 'default'`, `keyScope = 'stealth'` in both. Note `keyScope` is deliberately **decoupled from the network**: don't pass a network name into it.

### "Different keys every time I derive from my wallet"

Your signer is non-deterministic. Wallet-derived keys require an RFC 8032 deterministic signer; the SDK signs twice and throws when they differ, precisely to stop you from creating unrecoverable keys.

---

## Next steps

- [Getting Started](./05-getting-started.md) — install and first run
- [CLI Reference](./06-cli-reference.md) — every flag
- [SDK Reference](./07-sdk-reference.md#typed-errors) — the full error table
- [Security](./09-security.md) — limits and assumptions
