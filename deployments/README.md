# Deployments

`<network>.json` is the single source of truth for the canonical Shade
deployment on each network: the stealth pool contract, the wasm it runs, and the
public relayer and indexer. Web, docs and examples should take their values from
here rather than copying them around.

Only `testnet.json` exists today. Mainnet ships after the external audit.

## Using it

```bash
# CLI — any one of these (precedence: flag > env > file)
shade send <meta-address> 10 --method pool --contract <contractId>
export SHADE_CONTRACT=<contractId>
shade config set-contract <contractId>     # writes ~/.stealth/testnet-contract
shade config show                          # prints the contract in use and its source
```

```ts
// SDK
const client = new StealthClient({
  network: 'testnet',
  contractId: '<stealthPool.contractId>',
  relayer: '<relayerUrl>',
  indexerUrl: '<indexerUrl>',
});
```

## Verifying the contract

The deployed bytecode must be reproducible from `stealthPool.sourceCommit`:

```bash
git checkout <sourceCommit>
cd contracts && stellar contract build
sha256sum target/wasm32v1-none/release/stealth_registry.wasm   # == stealthPool.wasmSha256

stellar contract fetch --id <contractId> --network testnet --out-file deployed.wasm
sha256sum deployed.wasm                                         # == stealthPool.wasmSha256
```

`verifiedBuild` records the toolchain that last reproduced the hash. A
different `rustc` or `stellar` CLI version can produce different bytes.

## Updating after a testnet reset or a contract change

Testnet is wiped periodically, and any change under `contracts/` (including a
`soroban-sdk` bump) changes the wasm hash. In either case:

1. Build from a clean checkout of the commit you are deploying and note the wasm sha256.
2. Deploy with `contracts/deploy.sh testnet` (or `stellar contract deploy`).
3. Update `stealthPool` here: `contractId`, `wasmSha256`, `wasmSizeBytes`,
   `sourceCommit`, `sorobanSdk`, `verifiedBuild`, `deployedAt`, `deployer`.
   Move the previous entry to `deprecated` if it is still live and holds funds.
4. Update the Web app's `VITE_*` contract setting to the same id.
