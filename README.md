# Stellar Stealth Accounts SDK

**Privacy-preserving payments on Stellar using DKSAP (Dual-Key Stealth Address Protocol)**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Application Layer                       │
├─────────────────┬────────────────┬──────────────────────────┤
│  packages/cli   │                │   packages/relayer       │
│  User Interface │                │  Sponsorship Service     │
│  • send         │                │  • Fund stealth accounts │
│  • scan         │                │  • Fee bumping           │
│  • withdraw     │                │  • HTTP API              │
└────────┬────────┴────────────────┴────────┬─────────────────┘
         │                                   │
         ▼                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    packages/crypto (SDK)                     │
│                                                              │
│  • Key derivation (DKSAP protocol)                          │
│  • Stealth address generation                               │
│  • ECDH shared secret computation                           │
│  • View tag generation for fast scanning                    │
│  • Pure TypeScript, no Stellar SDK dependency               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  contracts/registry                          │
│                  (Soroban Smart Contract)                    │
│                                                              │
│  • Meta-address registration                                │
│  • Ephemeral key announcement storage                       │
│  • On-chain stealth protocol coordination                   │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Start local Stellar network
docker compose up -d

# Run the interactive demo
npm run demo
```

The demo will:
1. Generate stealth meta-addresses for Bob
2. Send funds to Bob's stealth address (as Alice)
3. Scan for received payments (as Bob)
4. Withdraw funds to Bob's regular account

## CLI Command Reference

| Command | Description | Example |
|---------|-------------|---------|
| `generate` | Create new stealth keypair | `stealth generate --keystore bob.json` |
| `address` | Display stealth meta-address | `stealth address --keystore bob.json` |
| `send` | Send XLM to stealth address | `stealth send --amount 10 --to <meta-address>` |
| `scan` | Find received stealth payments | `stealth scan --keystore bob.json` |
| `withdraw` | Move funds from stealth to regular account | `stealth withdraw --keystore bob.json --to GDEST...` |
| `balance` | Check stealth account balance | `stealth balance GA3X...` |

## How the Relayer Works

The relayer service sponsors stealth account creation using Stellar's fee-bump transactions (CAP-0033):

1. **Account Creation**: When a stealth payment is sent, the relayer creates the destination account with a sponsored reserve
2. **Fee Sponsorship**: The relayer covers network fees for stealth withdrawals, preserving privacy
3. **HTTP API**: Exposes endpoints for requesting sponsorship and checking service status

The relayer runs as a standalone HTTP service on port 3000 and maintains a funded Stellar account for sponsorship operations.

## SDK Documentation

For detailed SDK documentation and integration guide, see [packages/crypto/README.md](packages/crypto/README.md).

## Development

```bash
# Build all packages
npm run build

# Run tests
npm test

# Run Rust contract tests
cd contracts && cargo test

# Deploy contracts to local network
cd contracts && stellar contract deploy --wasm target/wasm32-unknown-unknown/release/registry.wasm --network local
```

## Security Considerations

- **Never share spend private keys** - These control funds in stealth accounts
- **View keys enable scanning only** - Safe to share with trusted scanning services
- **Use local network for development** - Never test with real funds on mainnet
- **Ephemeral stealth keys** - Generated per-transaction, exist only in memory during withdrawal

## License

MIT