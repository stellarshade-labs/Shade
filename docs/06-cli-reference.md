---
title: CLI Reference
description: "Every shade CLI command and flag: keygen, address, send, scan, balance, claim and withdraw, plus secret handling and the encrypted keystore format."
---

# Shade CLI Reference

`shade` is the reference command-line tool and the fastest way to run the whole flow. Seven commands: `keygen`, `address`, `send`, `scan`, `balance`, `claim`, `withdraw`.

This page documents every command's arguments and flags.

---

## Conventions

**Secrets.** Every secret resolves in this order: **inline flag, then environment variable, then a non-echoing stderr prompt**. Flags exist for scripting but leak into shell history and `ps` output, so prefer the env var or the prompt.

**Prompts fail loudly without stdin.** If stdin closes before a prompt is answered (piped input, CI), the command exits **1** with `stdin closed before input was received — pass the value via its flag or environment variable instead`. In non-interactive contexts, supply every needed value via its flag or env var.

| Variable | Used by |
|---|---|
| `SHADE_FROM_SECRET` | `send` (sender secret) |
| `SHADE_FEE_PAYER` | `claim`, `withdraw` (fee-payer secret) |
| `SHADE_FUNDING_SECRET` | `claim`, `withdraw` (funding-account secret — signs the credit-gated relayer challenge) |
| `SHADE_KEYSTORE` | every command (keystore path) |

**Keystore path** resolves as: `--keystore <path>` → `$SHADE_KEYSTORE` → `~/.shade-keys.json`.

**Relayers.** `--relay` (on `claim` and `withdraw`) is **repeatable and comma-separated**: `--relay https://a,https://b` and `--relay https://a --relay https://b` both work. It falls back to the comma-separated **`SHADE_RELAYERS`** env var when omitted. With more than one URL the client health-probes all candidates in parallel, routes to a healthy one (random by default, spreading users across the set), and fails over on relayer faults. `--verbose` prints the chosen relayer. When none is usable, the error lists every candidate with its rejection reason. See [Relayer → Choosing a relayer](./08-relayer.md#choosing-a-relayer).

**Indexer.** `--indexer <url>` (on `scan` and `balance`) points account-method discovery at an [announcement indexer](./03-architecture.md#the-announcement-indexer) and falls back to the **`SHADE_INDEXER`** env var when omitted (flag wins; a single URL, no list). Horizon remains the source of truth: the scan verifies the indexer's health first, always finishes with a Horizon tail, and degrades silently to the plain Horizon walk on any indexer fault. `scan --verbose` reports the indexer in use.

**Networks:** `--network testnet` is the default and the **only** accepted value today. Anything else, notably the removed `local` and the not-yet-audited `mainnet`, is rejected with an error. Mainnet ("public") arrives after the external audit.

---

## `shade keygen`

Generate or recover stealth keys and write a keystore. Prints your meta-address.

```bash
shade keygen                              # random keys; keystore ENCRYPTED by default
shade keygen --mnemonic                   # new BIP-39 mnemonic (enables recovery)
shade keygen --recover                    # recover from an existing 12-word mnemonic
shade keygen --from-stellar-secret        # derive deterministically from a Stellar secret
shade keygen --plaintext                  # opt OUT of encryption
shade keygen --force                      # required to OVERWRITE an existing keystore
```

| Flag | Description |
|---|---|
| `--keystore <path>` | Keystore file path (defaults to `$SHADE_KEYSTORE` or `~/.shade-keys.json`) |
| `--password [password]` | Encrypt the keystore with AES-256-GCM (prompts on stderr if the flag is given without a value) |
| `--plaintext` | Write an **UNENCRYPTED** keystore (opt out of default encryption) |
| `--no-encrypt` | Alias for `--plaintext` |
| `--mnemonic` | Generate keys from a new BIP-39 mnemonic (enables recovery) |
| `--recover` | Recover keys from an existing 12-word mnemonic |
| `--from-stellar-secret [secret]` | Derive keys deterministically from a Stellar secret (SEP-53) |
| `--app-id <id>` | Application id to scope derived keys (default: `default`) |
| `--key-scope <scope>` | Key-derivation scope (default: `stealth`) |
| `--force` | Overwrite an existing keystore (**destroys** the old keys and access to their unclaimed funds) |

**Keygen refuses to overwrite.** If a keystore already exists at the target path, `keygen` exits with an error rather than clobbering it: overwriting destroys the old spend/view keys, and with them access to any unclaimed funds sent to the old meta-address. Either write elsewhere with `--keystore <path>`, re-display the existing meta-address with `shade address`, or pass `--force` if you really mean to overwrite.

**Encryption is the default.** A plaintext keystore is written only when you explicitly opt out with `--plaintext` / `--no-encrypt`. Combining `--plaintext` with `--password` is an error, and an empty password is rejected.

> **Keystore format.** AES-256-GCM over the two private keys; public keys stay in the clear. The KDF is **scrypt** with `N=131072, r=8, p=1` for new keystores (envelope v2), with the parameters stored in the envelope. Older envelopes without stored params fall back to Node's defaults (`N=16384`) so they still decrypt. Files are written with mode `0600`.

> **`--app-id` / `--key-scope` must match across every tool** that derives keys from the same wallet or secret, or you get different, non-interoperable keys. `--key-scope` is deliberately **decoupled from `--network`** so the same keys work regardless of which network you later transact on. These defaults line up with the SDK's `DEFAULT_APP_ID` / `DEFAULT_KEY_SCOPE`.

---

## `shade address`

Re-display the meta-address of an **existing** keystore. **No password needed:** both the plaintext and encrypted envelopes store the spend/view public keys in the clear, and the meta-address derives purely from them.

```bash
shade address                             # prints shade:stellar:...
```

| Flag | Description |
|---|---|
| `--keystore <path>` | Keystore file path (defaults to `$SHADE_KEYSTORE` or `~/.shade-keys.json`) |

This is the safe answer to "I lost my meta-address," as opposed to re-running `shade keygen`, which would overwrite the keys (and refuses to without `--force`).

---

## `shade send`

Send to a stealth address derived from a meta-address.

```bash
shade send <meta-address> <amount> --method auto --network testnet
shade send <meta-address> 100 --method pool
shade send <meta-address> 200 --method account --asset USDC:GISSUER
```

| Argument | Description |
|---|---|
| `<meta-address>` | Recipient meta-address (`shade:stellar:...` or `spend:view` hex) |
| `<amount>` | Amount in whole units (e.g. `100` for 100 XLM) |

| Flag | Description |
|---|---|
| `--method <method>` | **Required.** `pool` \| `account` \| `auto` |
| `--network <network>` | Network to use (default: `testnet`; only `testnet` accepted) |
| `--from <secret>` | Sender secret key (prefer `$SHADE_FROM_SECRET` or the prompt) |
| `--asset <asset>` | Asset to send (default: native XLM, or `CODE:ISSUER`) |
| `--relay <url>` | Relayer URL for the account-method fee-bump (single URL; ignored by the pool method, which is a plain sender-signed deposit) |
| `--verbose` | Show detailed output |

**A method is mandatory.** `auto` resolves to `account` for native XLM above 1 XLM, otherwise `pool`.

The amount is parsed to exact stroops **before** any float math, so more than 7 decimal places or an out-of-range value is rejected up front rather than drifting.

---

## `shade scan`

Find payments sent to you, across **both** the pool and account methods.

```bash
shade scan --network testnet
shade scan --indexer http://localhost:3100
shade scan --full-rescan
```

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `testnet`; only `testnet` accepted) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts on stderr if omitted for an encrypted keystore) |
| `--since-ledger <ledger>` | Only scan announcements since this ledger |
| `--full-rescan` | Reset the account-method Horizon cursor and rescan from genesis. With an indexer configured, also requests the exhaustive pre-indexer walk |
| `--indexer <url>` | Announcement indexer URL for fast account-method discovery. Falls back to `$SHADE_INDEXER`; Horizon remains the source of truth |
| `--verbose` | Show detailed scan progress (cursor, indexer in use, per-phase timings) |

**Cursors.** The account method persists a Horizon paging cursor and its discovered payments to `~/.stealth/`, so a later `claim` can resolve a payment without a full rescan. `--full-rescan` clears both, and, with an indexer configured, additionally walks the **pre-indexer history**: a cold scan otherwise fast-starts at the indexer's coverage start, so a payment predating that coverage is found only by `--full-rescan`. See [Architecture → The announcement indexer](./03-architecture.md#the-announcement-indexer).

---

## `shade balance`

Show your total balance across all discovered stealth payments.

```bash
shade balance --network testnet
```

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `testnet`; only `testnet` accepted) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts if omitted) |
| `--indexer <url>` | Announcement indexer URL for fast account-method discovery. Falls back to `$SHADE_INDEXER`; Horizon remains the source of truth |

Balances are aggregated per token in stroops and displayed with a readable asset label (`XLM` rather than the native SAC `C...` address).

> **Paging.** `balance` and `withdraw` reuse `scan`'s paged announcement fetch, so all three page through the **full** announcement set: a payment is found regardless of its index in the pool.

---

## `shade claim`

Claim a discovered payment to a destination address. This is the **preferred, unified** command: it handles both pool and account payments.

```bash
shade claim <stealth-addr> <destination> --fee-payer S...                    # pool withdraw
shade claim <stealth-addr> <destination> --relay http://localhost:3000       # account sweep
shade claim <stealth-addr> <destination> --sponsored --funding-account G...  # token, no reserves

# Against a credit-gated relayer (the default), the funding account must also
# SIGN the relayer's challenge — supply its secret (prefer the env var):
SHADE_FUNDING_SECRET=S... shade claim <stealth-addr> <destination> \
  --relay https://relayer.example --funding-account G...
```

The funding secret alone is enough: the account is derived from it, and passing both asserts they match. Without a signer, a credit-gated relayer rejects the request (`401 missing_auth`).

| Argument | Description |
|---|---|
| `<stealth-address>` | Stealth address holding the funds |
| `<destination>` | Destination Stellar address (`G...`) |

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `testnet`; only `testnet` accepted) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts if omitted) |
| `--merge` | Sweep the whole account via `AccountMerge` (account method) |
| `--no-merge` | Leave the stealth account open (partial payout) |
| `--relay <url>` | Relayer URL(s) for fee-bumped submission; repeatable or comma-separated; falls back to `$SHADE_RELAYERS` |
| `--sponsored` | Use the relayer sponsor-claim pair (token claimable-balance claims) |
| `--funding-account <address>` | App account to debit a credit-gated relayer fee against |
| `--funding-secret <secret>` | Secret controlling the funding account; signs the relayer challenge (prefer `$SHADE_FUNDING_SECRET`) |
| `--fee-payer <secret>` | Secret paying the pool-withdraw Soroban fee (prefer `$SHADE_FEE_PAYER`) |
| `--asset <asset>` | Asset to claim, pool method: `native` or `CODE:ISSUER` |
| `--amount <amount>` | Partial claim amount (account method, with `--no-merge`) |
| `--verbose` | Show detailed output |

**How it routes:** `claim` looks the stealth address up in the persisted account-method payment cache. A **hit** takes the account path; a **miss** is assumed to be a pool deposit and runs the same pool-withdraw path as `withdraw`.

---

## `shade withdraw`

Direct pool withdrawal. **Deprecated:** `claim` is the preferred unified command and routes pool payments through this same path. `withdraw` remains for the explicit pool case and for scripts that already use it.

```bash
shade withdraw <stealth-addr> <destination> --fee-payer S... --asset USDC:GISSUER
```

| Argument | Description |
|---|---|
| `<stealth-address>` | Stealth address to withdraw from |
| `<destination>` | Destination Stellar address |

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `testnet`; only `testnet` accepted) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts if omitted) |
| `--amount <amount>` | Amount to withdraw (default: full balance) |
| `--asset <asset>` | Asset to withdraw (default: native XLM, or `CODE:ISSUER`) |
| `--fee-payer <secret>` | Secret of the account paying the Soroban fee (prefer `$SHADE_FEE_PAYER`) |
| `--relay <url>` | Relayer URL(s) for fee-bumped submission; repeatable or comma-separated; falls back to `$SHADE_RELAYERS` |
| `--funding-account <address>` | App account to debit a credit-gated relayer fee against |
| `--funding-secret <secret>` | Secret controlling the funding account; signs the relayer challenge (prefer `$SHADE_FUNDING_SECRET`) |
| `--verbose` | Show detailed output |

A fee payer is **required**. If the recipient's pool entry has archived, the CLI transparently submits a `RestoreFootprintOp` first and rebuilds the withdraw on a fresh sequence.

---

## Local state

The CLI keeps state under `~/.stealth/`:

| File | Contents |
|---|---|
| `<network>-contract` | The pool contract address |
| `horizon-cursor-<network>` | Account-method Horizon paging cursor |
| `horizon-payments-<network>.json` | Discovered account-method payments (deduplicated) |

The keystore itself defaults to `~/.shade-keys.json`.

---

## Next steps

- [Getting Started](./05-getting-started.md): install and first run
- [Delivery Methods](./04-delivery-methods.md): what `--method` actually changes
- [SDK Reference](./07-sdk-reference.md): the programmatic equivalent
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md): common command failures
