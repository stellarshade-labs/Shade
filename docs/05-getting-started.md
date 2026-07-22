---
title: Getting Started
description: "Run Shade end-to-end on Stellar testnet: prerequisites, install, generating and funding testnet keys, deploying the Soroban contract, and your first commands."
---

# Getting Started with Shade

Run Shade end-to-end on Stellar **testnet** in a few minutes. This page covers prerequisites, install, generating and funding testnet keys, deploying the contract, and your first commands.

---

## Prerequisites

- **Node.js 20+**
- **Stellar CLI**, needed to build and deploy the Soroban contract and to generate/fund testnet keys
- **Rust toolchain**, needed to compile the contract to Wasm

## Install and build

```bash
npm install

# Build every TypeScript package
npm run build

# Build the Soroban contract
cd contracts && stellar contract build && cd ..
```

## Generate and fund a testnet account

Generate a keypair and fund it from friendbot. Repeat for any accounts you need: a deployer, a sender, a fee payer.

```bash
stellar keys generate deployer --network testnet
stellar keys fund deployer --network testnet
```

## Deploying the contract

```bash
bash contracts/deploy.sh --network testnet --source deployer
```

The script builds the contract, deploys it to testnet, and writes the resulting contract id to `~/.stealth/testnet-contract`, where the CLI will find it.

**How the CLI resolves the contract address:** it reads `~/.stealth/<network>-contract`. There is deliberately **no built-in testnet address**. Testnet resets periodically, and a stale placeholder would only produce an opaque Soroban failure later. If the file is missing, the CLI throws an actionable error naming the exact file to write, and the SDK throws `ContractIdRequiredError`.

If you prefer to deploy by hand instead of the script:

```bash
stellar contract deploy \
  --wasm contracts/registry/target/wasm32-unknown-unknown/release/stealth_registry.wasm \
  --source deployer --network testnet

# then save it where the CLI looks:
echo "C..." > ~/.stealth/testnet-contract
```

For the full worked smoke flow (deposit, scan, balance, direct withdraw, relayer fee-bumped withdraw, with native XLM), see [RESULTS-testnet-smoke](./RESULTS-testnet-smoke.md).

## Your first commands

```bash
# 1. Generate keys. The keystore is ENCRYPTED by default (AES-256-GCM).
#    --mnemonic gives you a 12-word backup phrase.
shade keygen --mnemonic
# prints your meta-address: shade:stellar:...

# 2. Send. A delivery method is REQUIRED — there is no implicit default.
#    Supply the secret via $SHADE_FROM_SECRET or the prompt, never a flag.
export SHADE_FROM_SECRET=S...
shade send <meta-address> 100 --method pool --network testnet

# 3. Find what you received
shade scan --network testnet
shade balance --network testnet

# 4. Claim to your real address
export SHADE_FEE_PAYER=S...
shade claim <stealth-address> <your-G-address> --network testnet
```

> **Secrets never belong on the command line.** `--from` and `--fee-payer` exist for scripting, but a flag leaks into shell history and `ps` output. Prefer `SHADE_FROM_SECRET`, `SHADE_FEE_PAYER`, or the stderr prompt.

## Running the relayer (optional)

The relayer pays your withdrawal fee so you never reveal a funded account of your own:

```bash
RELAYER_SECRET=S... npx tsx packages/relayer/src/index.ts
# or, from the repo root:
npm run relayer:dev
```

Then pass `--relay http://localhost:3000` to `claim`/`withdraw`. See [Relayer](./08-relayer.md) for endpoints, credit gating, and deployment.

## Running the indexer (optional)

The announcement indexer makes account-method discovery fast. It walks the global Horizon transaction feed once for everyone, so a cold scan no longer has to:

```bash
cd packages/indexer && npm run dev    # NETWORK=testnet, port 3100
```

Then pass `--indexer http://localhost:3100` to `scan`/`balance` (or set `SHADE_INDEXER`). Horizon remains the source of truth: a scan falls back to the plain Horizon walk automatically if the indexer is down. See [Architecture → The announcement indexer](./03-architecture.md#the-announcement-indexer) for the trust model, endpoints, and configuration.

## Using the SDK instead

```typescript
import { StealthClient } from 'stellar-shade';

const client = new StealthClient({
  network: 'testnet',
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
| `testnet` | Testnet | `https://soroban-testnet.stellar.org` | `https://horizon-testnet.stellar.org` |

`testnet` is the only accepted network today. Mainnet ("public") is a forward-looking, post-audit addition.

> **Status note.** The **pool** method has been validated end-to-end on Stellar **testnet** (2026-07-17) with **native XLM**: deposit, scan, balance, direct withdraw, and relayer fee-bumped withdraw. The pool contract is **asset-agnostic**. It calls the standard SAC token interface (`token::Client`) with the token address as a parameter, so a classic asset such as USDC takes the identical path, differing only in that address. No testnet contract id is pinned, because testnet **resets quarterly**, so deploy your own and save it as shown above. The **account** method's cold discovery is served by the **announcement indexer**. It is covered by unit and integration tests, and by design every scan ends with a Horizon tail, so an unreachable or degraded indexer falls back to the plain walk. The 2026-07-17 testnet smoke did **not** exercise account-method discovery, though, so treat the indexer as implemented and test-covered, **not** testnet-validated. Without an indexer configured, a cold account scan still walks the global Horizon transaction feed, which is impractical for a fresh recipient on a busy network. There is no CI. Mainnet is **out of scope** until an external audit lands. See [Security](./09-security.md).

---

## Next steps

- [CLI Reference](./06-cli-reference.md): every command and flag
- [SDK Reference](./07-sdk-reference.md): `StealthClient`, types, errors
- [Delivery Methods](./04-delivery-methods.md): choosing `pool` vs `account`
- [FAQ & Troubleshooting](./10-faq-troubleshooting.md): when something fails
