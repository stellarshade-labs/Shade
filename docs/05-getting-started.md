---
title: Getting Started
description: "Run Shade end-to-end on a local Stellar network: prerequisites, install, the one-command demo, deploying the Soroban contract, and your first commands."
---

# Getting Started with Shade

Run Shade end-to-end on a local Stellar network in a few minutes. This page covers prerequisites, install, the one-command demo, deploying the contract yourself, and your first real commands.

---

## Prerequisites

- **Node.js 20+**
- **Docker** (runs the local Stellar network)
- **Stellar CLI** — needed to build and deploy the Soroban contract
- **Rust toolchain** — needed to compile the contract to Wasm

## Install and build

```bash
npm install

# Start the local Stellar network (Horizon + RPC on port 8000)
docker compose up -d

# Build every TypeScript package
npm run build

# Build the Soroban contract
cd contracts && stellar contract build && cd ..
```

The local network is the `stellar/quickstart:testing` image run with `--local`, exposed on port `8000`.

## The fastest path: run the demo

```bash
bash demo.sh          # or: npm run demo
```

The demo takes roughly 3 minutes and exercises the whole system:

1. Deploys the stealth pool contract + the native XLM SAC
2. Starts the relayer service
3. Generates stealth meta-addresses for Bob
4. Alice deposits 100 XLM into the pool
5. Alice deposits 200 USDC into the pool (multi-token)
6. Bob scans and detects both deposits with his view key
7. Bob withdraws XLM directly (a fee-payer pays the Soroban fee)
8. Bob withdraws USDC via the relayer (fee-bump for privacy)
9. Verifies there is no on-chain link between Bob and the stealth addresses

## Deploying the contract yourself

```bash
cd contracts
./deploy.sh --network local --source deployer
```

The script builds the contract, deploys it, and writes the resulting contract id where the CLI will find it.

**How the CLI resolves the contract address**, in order:
1. `~/.stealth/<network>-contract`
2. *(local only)* `packages/cli/.stealth/local-contract`
3. *(local only)* a built-in default

There is deliberately **no built-in testnet address** — testnet resets periodically, and a stale placeholder would only produce an opaque Soroban failure later. For testnet you must deploy and save the id yourself:

```bash
stellar contract deploy \
  --wasm contracts/registry/target/wasm32-unknown-unknown/release/stealth_registry.wasm \
  --source <account> --network testnet

# then save it where the CLI looks:
echo "C..." > ~/.stealth/testnet-contract
```

If you skip this, the CLI throws an actionable error naming the exact file to write, and the SDK throws `ContractIdRequiredError`.

## Your first commands

```bash
# 1. Generate keys. The keystore is ENCRYPTED by default (AES-256-GCM).
#    --mnemonic gives you a 12-word backup phrase.
shade keygen --mnemonic
# prints your meta-address: shade:stellar:...

# 2. Send. A delivery method is REQUIRED — there is no implicit default.
#    Supply the secret via $SHADE_FROM_SECRET or the prompt, never a flag.
export SHADE_FROM_SECRET=S...
shade send <meta-address> 100 --method pool --network local

# 3. Find what you received
shade scan --network local
shade balance --network local

# 4. Claim to your real address
export SHADE_FEE_PAYER=S...
shade claim <stealth-address> <your-G-address> --network local
```

> **Secrets never belong on the command line.** `--from` and `--fee-payer` exist for scripting, but a flag leaks into shell history and `ps` output. Prefer `SHADE_FROM_SECRET` / `SHADE_FEE_PAYER` or the stderr prompt.

## Running the relayer (optional)

The relayer pays your withdrawal fee so you never reveal a funded account of your own:

```bash
RELAYER_SECRET=S... npx tsx packages/relayer/src/index.ts
# or, from the repo root:
npm run relayer:dev
```

Then pass `--relay http://localhost:3000` to `claim`/`withdraw`. See [Relayer](./08-relayer.md) for endpoints, credit gating, and deployment.

## Using the SDK instead

```typescript
import { StealthClient } from '@shade/sdk';

const client = new StealthClient({
  network: 'local',
  contractId: 'C...',            // required whenever 'pool' is enabled
  methods: ['pool', 'account'],
});

const bob = StealthClient.keygen();   // share bob.metaAddress

await client.send(bob.metaAddress, 100, aliceSecret, { method: 'auto' });

const payments = await client.scan(bob);
await client.claim(payments[0], bobPublicKey, {
  keys: bob,
  feePayer: feePayerSecret,
});
```

Full API in the [SDK Reference](./07-sdk-reference.md).

## Tests

```bash
npm run test                 # all TypeScript packages, then cargo test
cd contracts && cargo test   # Rust contract tests only
```

## Networks

| Network | Passphrase | RPC | Horizon |
|---|---|---|---|
| `local` | Standalone | `http://localhost:8000/soroban/rpc` | `http://localhost:8000` |
| `testnet` | Testnet | `https://soroban-testnet.stellar.org` | `https://horizon-testnet.stellar.org` |

Fund a `local` or `testnet` account with friendbot before using it.

> **Status note.** The **pool** method has been validated end-to-end on Stellar **testnet** (2026-07-17): deposit → scan → balance → direct withdraw → relayer fee-bumped withdraw, for both native XLM and a classic-asset (USDC) SAC. No testnet contract id is pinned — testnet **resets quarterly**, so deploy your own and save it as shown above. The **account** method's discovery does **not** scale on a public network: its scan (and `balance`) walk the global Horizon transaction feed, so a cold scan for a fresh recipient is impractical — a Horizon indexer is the roadmap fix. Day-to-day development (including `demo.sh`) still runs on the Docker local network, and there is no CI. Mainnet is **out of scope** until an external audit lands. See [Security](./09-security.md).

---

## Next steps

- [CLI Reference](./06-cli-reference.md) — every command and flag
- [SDK Reference](./07-sdk-reference.md) — `StealthClient`, types, errors
- [Delivery Methods](./04-delivery-methods.md) — choosing `pool` vs `account`
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md) — when something fails
