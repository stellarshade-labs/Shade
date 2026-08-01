# stellar-shade-cli

[![npm](https://img.shields.io/npm/v/stellar-shade-cli.svg)](https://www.npmjs.com/package/stellar-shade-cli)

`shade` — the reference command-line tool for **private payments on Stellar** via
stealth addresses (DKSAP on ed25519). It's the fastest way to run the whole
send → scan → claim flow from a terminal, built on the
[`stellar-shade`](https://www.npmjs.com/package/stellar-shade) SDK.

```bash
npm install -g stellar-shade-cli
```

This installs a single `shade` command with seven subcommands: `keygen`,
`address`, `send`, `scan`, `balance`, `claim`, and `withdraw`. Currently
**testnet-only** — mainnet is rejected pending an external crypto audit.

## Commands

```bash
# Generate stealth keys. The keystore is ENCRYPTED by default (AES-256-GCM);
# keygen prints your shareable meta-address.
shade keygen                      # random keys
shade keygen --mnemonic           # new BIP-39 mnemonic (enables recovery)
shade keygen --recover            # recover from an existing 12-word mnemonic
shade keygen --plaintext          # opt OUT of encryption
shade keygen --force              # overwrite an existing keystore (DESTROYS old keys)

# Re-print your meta-address from an existing keystore (no password needed).
shade address

# Send. A delivery method is REQUIRED: pool (private), account (direct), auto (pick).
# Supply the sender secret via $SHADE_FROM_SECRET or the stderr prompt.
shade send <meta-address> 100 --method auto --network testnet
shade send <meta-address> 200 --method account --asset USDC:GISSUER

# Scan + balance (pool AND account methods).
shade scan --network testnet
shade balance --network testnet

# Claim a discovered payment to your real address (unified pool + account path).
shade claim <stealth-addr> <destination> --relay https://relay.example   # account sweep
shade claim <stealth-addr> <destination> --fee-payer SXXX                # pool withdraw

# (Legacy) direct pool withdraw; `claim` is the preferred unified command.
shade withdraw <stealth-addr> <destination> --fee-payer SXXX --asset USDC:GISSUER
```

Run `shade <command> --help` for every flag.

## Secrets & environment

Every secret resolves in this order: **inline flag → environment variable →
non-echoing stderr prompt**. Prefer the env var or the prompt; flags leak into
shell history and `ps` output.

| Variable | Used by |
| --- | --- |
| `SHADE_FROM_SECRET` | `send` (sender secret) |
| `SHADE_FEE_PAYER` | `claim`, `withdraw` (fee-payer secret) |
| `SHADE_FUNDING_SECRET` | `claim`, `withdraw` (funding-account secret) |
| `SHADE_KEYSTORE` | every command (keystore path) |
| `SHADE_RELAYERS` | `claim`, `withdraw` (comma-separated fallback for `--relay`) |
| `SHADE_INDEXER` | `scan`, `balance` (announcement-indexer fallback for `--indexer`) |

The keystore path resolves as `--keystore <path>` → `$SHADE_KEYSTORE` →
`~/.shade-keys.json`.

## Documentation

Full command reference, secret handling, and the encrypted keystore format:
[CLI Reference](https://github.com/stellarshade-labs/Shade/blob/main/docs/06-cli-reference.md).
For the programmatic SDK, see [`stellar-shade`](https://www.npmjs.com/package/stellar-shade).

## License

Apache-2.0
