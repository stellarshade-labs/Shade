---
title: CLI Reference
description: "Every shade CLI command and flag: keygen, send, scan, balance, claim and withdraw — plus secret handling and the encrypted keystore format."
---

# Shade CLI Reference

`shade` is the reference command-line tool and the fastest way to feel the whole flow. Six commands: `keygen`, `send`, `scan`, `balance`, `claim`, `withdraw`.

This page documents every command's real arguments and flags.

---

## Conventions

**Secrets.** Every secret resolves in this order: **inline flag → environment variable → non-echoing stderr prompt**. Flags exist for scripting but leak into shell history and `ps` output — prefer the env var or the prompt.

| Variable | Used by |
|---|---|
| `SHADE_FROM_SECRET` | `send` (sender secret) |
| `SHADE_FEE_PAYER` | `claim`, `withdraw` (fee-payer secret) |
| `SHADE_KEYSTORE` | every command (keystore path) |

**Keystore path** resolves as: `--keystore <path>` → `$SHADE_KEYSTORE` → `~/.shade-keys.json`.

**Networks:** `--network local` (default) or `--network testnet`.

---

## `shade keygen`

Generate or recover stealth keys and write a keystore. Prints your meta-address.

```bash
shade keygen                              # random keys; keystore ENCRYPTED by default
shade keygen --mnemonic                   # new BIP-39 mnemonic (enables recovery)
shade keygen --recover                    # recover from an existing 12-word mnemonic
shade keygen --from-stellar-secret        # derive deterministically from a Stellar secret
shade keygen --plaintext                  # opt OUT of encryption
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

**Encryption is the default.** A plaintext keystore is written only when you explicitly opt out with `--plaintext` / `--no-encrypt`. Combining `--plaintext` with `--password` is an error, and an empty password is rejected.

> **Keystore format.** AES-256-GCM over the two private keys; public keys stay in the clear. KDF is **scrypt** with `N=131072, r=8, p=1` for new keystores (envelope v2), with the parameters stored in the envelope. Older envelopes without stored params fall back to Node's defaults (`N=16384`) so they still decrypt. Files are written with mode `0600`.

> **`--app-id` / `--key-scope` must match across every tool** that derives keys from the same wallet/secret, or you get different, non-interoperable keys. `--key-scope` is deliberately **decoupled from `--network`** so the same keys work regardless of which network you later transact on. These defaults line up with the SDK's `DEFAULT_APP_ID` / `DEFAULT_KEY_SCOPE`.

---

## `shade send`

Send to a stealth address derived from a meta-address.

```bash
shade send <meta-address> <amount> --method auto --network local
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
| `--network <network>` | Network to use (default: `local`) |
| `--from <secret>` | Sender secret key (prefer `$SHADE_FROM_SECRET` or the prompt) |
| `--asset <asset>` | Asset to send (default: native XLM, or `CODE:ISSUER`) |
| `--relay <url>` | Relayer URL (account-method fee-bump) |
| `--verbose` | Show detailed output |

**A method is mandatory.** `auto` resolves to `account` for native XLM above 1 XLM when the account method is available, otherwise `pool`.

The amount is parsed to exact stroops **before** any float math, so more than 7 decimal places or an out-of-range value is rejected up front rather than drifting.

---

## `shade scan`

Find payments sent to you, across **both** the pool and account methods.

```bash
shade scan --network local
shade scan --full-rescan
```

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `local`) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts on stderr if omitted for an encrypted keystore) |
| `--since-ledger <ledger>` | Only scan announcements since this ledger |
| `--full-rescan` | Reset the account-method Horizon cursor and rescan from genesis |
| `--verbose` | Show detailed scan progress |

**Cursors.** The account method persists a Horizon paging cursor and its discovered payments to `~/.stealth/`, so a later `claim` can resolve a payment without a full rescan. `--full-rescan` clears both.

---

## `shade balance`

Show your total balance across all discovered stealth payments.

```bash
shade balance --network local
```

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `local`) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts if omitted) |

Balances are aggregated per token in stroops and displayed with a readable asset label (`XLM` rather than the native SAC `C...` address).

> **Known limitation.** `balance` and `withdraw` read announcements with a single capped request (limit 1000) rather than paging like `scan` does. In a pool with more than 1000 announcements, a payment at a higher index will not appear in `balance` and cannot be resolved by `withdraw`. See [FAQ & Troubleshooting](./10-faq-troubleshooting.md).

---

## `shade claim`

Claim a discovered payment to a destination address. This is the **preferred, unified** command — it handles both pool and account payments.

```bash
shade claim <stealth-addr> <destination> --fee-payer S...                    # pool withdraw
shade claim <stealth-addr> <destination> --relay http://localhost:3000       # account sweep
shade claim <stealth-addr> <destination> --sponsored --funding-account G...  # token, no reserves
```

| Argument | Description |
|---|---|
| `<stealth-address>` | Stealth address holding the funds |
| `<destination>` | Destination Stellar address (`G...`) |

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `local`) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts if omitted) |
| `--merge` | Sweep the whole account via `AccountMerge` (account method) |
| `--no-merge` | Leave the stealth account open (partial payout) |
| `--relay <url>` | Relayer URL for fee-bumped submission |
| `--sponsored` | Use the relayer sponsor-claim pair (token claimable-balance claims) |
| `--funding-account <address>` | App account to debit a credit-gated relayer fee against |
| `--fee-payer <secret>` | Secret paying the pool-withdraw Soroban fee (prefer `$SHADE_FEE_PAYER`) |
| `--asset <asset>` | Asset to claim, pool method: `native` or `CODE:ISSUER` |
| `--amount <amount>` | Partial claim amount (account method, with `--no-merge`) |
| `--verbose` | Show detailed output |

**How it routes:** `claim` looks the stealth address up in the persisted account-method payment cache. A **hit** takes the account path; a **miss** is assumed to be a pool deposit and delegates to the `withdraw` command.

---

## `shade withdraw`

Direct pool withdrawal. **Legacy** — `claim` is the preferred unified command, but `withdraw` remains for the explicit pool path.

```bash
shade withdraw <stealth-addr> <destination> --fee-payer S... --asset USDC:GISSUER
```

| Argument | Description |
|---|---|
| `<stealth-address>` | Stealth address to withdraw from |
| `<destination>` | Destination Stellar address |

| Flag | Description |
|---|---|
| `--network <network>` | Network to use (default: `local`) |
| `--keystore <path>` | Keystore file path |
| `--password <password>` | Keystore password (prompts if omitted) |
| `--amount <amount>` | Amount to withdraw (default: full balance) |
| `--asset <asset>` | Asset to withdraw (default: native XLM, or `CODE:ISSUER`) |
| `--fee-payer <secret>` | Secret of the account paying the Soroban fee (prefer `$SHADE_FEE_PAYER`) |
| `--relay <url>` | Relay URL for fee-bumped submission |
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

- [Getting Started](./05-getting-started.md) — install and first run
- [Delivery Methods](./04-delivery-methods.md) — what `--method` actually changes
- [SDK Reference](./07-sdk-reference.md) — the programmatic equivalent
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md) — common command failures
