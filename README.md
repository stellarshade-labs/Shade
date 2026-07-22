# Shade — Private Payments on Stellar

**Privacy-preserving payments on Stellar using DKSAP (Dual-Key Stealth Address Protocol)**

The first implementation of stealth addresses on Stellar. Supports multi-token deposits (XLM, USDC, any SAC token), atomic deposit+announce (spam-proof), and ed25519 signature-based withdrawals with optional relayer fee-bumping for enhanced privacy.

## Architecture

```
                        +-----------------------+
                        |    packages/crypto    |
                        |      (SDK core)       |
                        |                       |
                        | - DKSAP key derivation|
                        | - Stealth address gen |
                        | - ECDH shared secrets |
                        | - View tag scanning   |
                        | - HD keys (BIP-39)    |
                        | - Pure TS, no Stellar |
                        +-----------+-----------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
          +-------v--------+                 +--------v-------+
          |  packages/cli  |                 | packages/relayer|
          |  (Reference)   |                 |  (Fee-bump)    |
          |                |                 |                |
          | keygen / send  |                 | POST /relay    |
          | scan / balance |                 | Fee-bumps      |
          | withdraw       |                 | withdrawal txs |
          +-------+--------+                 +--------+-------+
                  |                                   |
                  +-----------------+-----------------+
                                    |
                  +-----------------v-----------------+
                  |      contracts/registry           |
                  |      (Soroban Pool Contract)      |
                  |                                   |
                  | deposit() - atomic deposit+announce|
                  | withdraw() - ed25519 sig verified  |
                  | get_balance() / get_nonce()        |
                  | get_announcements()                |
                  +-----------------------------------+
```

**Key design decisions:**
- **Why a pool contract?** Stellar charges a ~1 XLM minimum balance reserve (MBR) for every account, so handing out a fresh address per payment would lock ~1 XLM each time. Instead we hold funds in a Soroban contract with per-stealth-key accounting: no account is created and no base reserve is locked, so a deposit costs only the Soroban invocation fee.
- Contract tracks balances per stealth key (not a mixer: each key has its own isolated balance)
- Deposit and announcement are atomic (no spam)
- Withdrawals use ed25519 signature auth (stealth keys aren't Stellar accounts)
- Replay protection via strictly-increasing nonces per stealth key
- Relayer covers the small withdrawal tx fee so the recipient doesn't reveal which funded account they control
- Multi-token: any SAC-wrapped asset (native XLM, USDC, custom tokens)

## Quick Start

```bash
# Prerequisites: Node.js 20+, Stellar CLI, Rust toolchain
npm install

# Build everything
npm run build
cd contracts && stellar contract build && cd ..

# Generate + fund a testnet account (repeat for any accounts you need)
stellar keys generate deployer --network testnet
stellar keys fund deployer --network testnet

# Deploy the pool contract to testnet (writes the id to ~/.stealth/testnet-contract)
bash contracts/deploy.sh --network testnet --source deployer
```

Then drive a full send -> scan -> claim cycle with the CLI (below).

## SDK Usage

The SDK ships on npm as [`stellar-shade`](https://www.npmjs.com/package/stellar-shade) (the `@shade/crypto` math is bundled in, so this one install pulls in everything):

```bash
npm install stellar-shade
```

```typescript
import { StealthClient } from 'stellar-shade';

// `contractId` is required whenever the pool method is enabled (mandatory on testnet).
const client = new StealthClient({
  network: 'testnet',
  contractId: 'CXXX...',
  methods: ['pool', 'account'],
});

// Generate keys (no network needed)
const bobKeys = StealthClient.keygen();
// bobKeys.metaAddress → "shade:stellar:..." (share publicly)

// Alice sends 100 XLM to Bob's stealth address. A delivery method is REQUIRED:
// 'pool' (private), 'account' (direct classic tx), or 'auto' (picks one). There
// is no implicit default, so omitting `method` throws MethodRequiredError.
const receipt = await client.send(bobKeys.metaAddress, 100, aliceSecret, {
  method: 'auto',
});
// receipt.stealthAddress, receipt.txHash

// Bob scans for received payments (client.scanWithCursor gives an incremental cursor).
const payments = await client.scan(bobKeys);
// [{ stealthAddress, amount: 100, asset: "XLM", method: "pool", ... }]

// Bob claims a payment to his real address. `claim` takes the Payment object and
// branches on its method (pool → signed withdraw, account → sweep/partial payout).
const result = await client.claim(payments[0], bobPublicKey, {
  keys: bobKeys,
  feePayer: feePayerSecret,           // pool claims need a fee payer for the Soroban fee
  relay: 'http://localhost:3000',      // optional: relayer fee-bumps for privacy
});
// result.txHash, result.amount, result.method
```

That's it. No DKSAP math, no Soroban transactions, no message serialization.

## CLI Commands

```bash
# Generate stealth keys (keygen prints the meta-address; the keystore path is
# --keystore <path> or $SHADE_KEYSTORE, honored by every command).
shade keygen                              # Random keys; keystore ENCRYPTED by default (AES-256-GCM)
shade keygen --mnemonic                   # New BIP-39 mnemonic (enables recovery)
shade keygen --recover                    # Recover from an existing 12-word mnemonic
shade keygen --password                   # Set the encryption password explicitly (else prompts on stderr)
shade keygen --plaintext                  # Opt OUT of encryption (writes an UNENCRYPTED keystore)
shade keygen --force                      # Required to OVERWRITE an existing keystore (destroys the old keys + any unclaimed funds)

# Re-print your meta-address from an existing keystore, no password needed
# (public keys are stored in the clear; use this instead of re-running keygen).
shade address

# Send: a delivery method is REQUIRED (pool = private, account = direct, auto = pick).
# --network defaults to testnet and only testnet is accepted (local was removed;
# mainnet is rejected as unaudited).
# Supply the secret via $SHADE_FROM_SECRET or the prompt so it never hits shell history.
shade send <meta-address> 100 --method auto --network testnet
shade send <meta-address> 100 --method pool --from SXXX
shade send <meta-address> 200 --method account --asset USDC:GISSUER

# Scan + balance (pool AND account); balance shows the asset label (e.g. XLM, not the SAC C-address)
shade scan --network testnet
shade balance --network testnet

# Claim a discovered payment to your real address (unified pool + account path)
shade claim <stealth-addr> <destination> --relay http://localhost:3000        # account sweep
shade claim <stealth-addr> <destination> --fee-payer SXXX                      # pool withdraw
shade claim <stealth-addr> <destination> --sponsored --funding-account G...    # token, no reserves

# (Legacy) direct pool withdraw; `claim` is the preferred unified command
shade withdraw <stealth-addr> <destination> --fee-payer SXXX --asset USDC:GISSUER
```

## Soroban Pool Contract

| Function | Description |
|----------|-------------|
| `deposit(sender, token, amount, stealth_pk, ephemeral_pk, view_tag)` | Atomic deposit + announcement |
| `withdraw(stealth_pk, token, amount, destination, nonce, signature)` | Ed25519-verified withdrawal |
| `get_balance(stealth_pk, token)` | Read pool balance |
| `get_nonce(stealth_pk)` | Read replay-protection nonce |
| `get_announcements(start, limit)` | Paginated announcement list |
| `get_announcements_by_tag(tag, start, limit)` | Filter by view tag |
| `get_announcement_count()` | Total announcement count |

**Withdraw message format** (must match byte-for-byte between Rust and TypeScript), a fixed 278-byte preimage:
```
SHA256(domain_tag(22) || stealth_pk(32) || token_strkey(56) || amount_be(16)
       || dest_strkey(56) || nonce_be(8) || contract_strkey(56) || network_id(32))
```
The leading 22-byte ASCII domain tag `SHADE-POOL-WITHDRAW-V1` (SH-3) separates a withdraw
preimage from any other message a stealth key might sign. The trailing contract address and
32-byte network id (SHA-256 of the network passphrase, = `env.ledger().network_id()` on-chain)
bind the signature to a single deployment + network, preventing cross-deployment /
cross-network signature replay.

## Relayer

The relayer pays the Soroban invocation fee on withdrawal transactions via fee-bumping. This is purely for **privacy**: without it, the recipient would need a funded account to pay the tx fee, linking their identity to the withdrawal. The relayer sees the XDR but learns nothing about the recipient's other accounts.

```bash
# Start relayer
RELAYER_SECRET=SXXX npx tsx packages/relayer/src/index.ts

# Endpoints
GET  /health          # Service status
POST /relay           # Submit XDR for fee-bump + broadcast
```

## DKSAP Protocol

- **Meta-address:** `(K_spend, K_view)` - two ed25519 public keys, shared publicly
- **Send:** pick random `r`, compute `R = r*G`, shared secret `S = r*K_view`, derive `P_stealth = K_spend + SHA256(S)*G`
- **View tag:** `SHA256(S)[0]` - first byte for fast scanning (~2x speedup)
- **Scan:** compute `S = k_view*R`, check view tag, verify stealth address
- **Recover:** `p_stealth = k_spend + SHA256(S) mod L`

## Development

```bash
npm run build                    # Build all TS packages
npm run test                     # Run all TS tests
cd contracts && cargo test       # Run Rust contract tests

# Generate + fund a testnet account, then deploy the contract to testnet
stellar keys generate deployer --network testnet
stellar keys fund deployer --network testnet
bash contracts/deploy.sh --network testnet --source deployer
```

## Privacy Model

Stealth addresses hide the **identity** of the recipient, not the **flow** of funds. The deposit→withdrawal chain is visible on-chain, but nobody can link the stealth address to the recipient's meta-address without the view key.

**What's private:**
- Recipient identity: stealth_pk is unlinkable to meta-address
- Recipient's funded accounts: relayer pays the tx fee, Bob's wallet never appears

**What's NOT private:**
- The deposit amount and the fact it went to a stealth address
- The withdrawal destination (but it's a fresh address with no history)
- Timing correlation: withdraw right after deposit and it's obvious

**User responsibility:** The cryptography provides the tools, but users can deanonymize themselves through behavior (timing, amount patterns, address reuse). Partial withdrawals help: withdraw different amounts at different times to reduce correlation with the original deposit.

**View key sharing:** If you share your view key with a scanning service, they can see all your incoming payments (past and future). There is no view key revocation. To stop a viewer, generate new keys and publish a new meta-address. Old payments remain visible to the old viewer.

## Known Limitations

- **Announcement reads must be paged:** Each announcement is its own keyed entry (`DataKey::Announcement(u64)`), so `deposit` is O(1) and storage has no `Vec` size ceiling. A single `get_announcements(start, limit)` response is still bounded by Soroban's return-size limit, so clients must page: the SDK pages at 200/request, and the CLI's `balance`/`withdraw` reuse `scan`'s paged fetch, so all three page the full announcement set.
- **Pre-audit, not for mainnet:** the **pool** method has been exercised end-to-end on Stellar **testnet** with **native XLM**. The pool contract is **asset-agnostic**: it calls the standard SAC token interface (`token::Client`) with the token address as a parameter, so a classic asset such as USDC takes the identical path, differing only in that address. No testnet contract id is pinned (testnet resets, so deploy your own). Mainnet is out of scope until an external audit lands.
- **Account-method discovery needs an indexer:** the account method's scan (and `balance`) walk the global Horizon transaction feed, so a cold scan for a fresh recipient is impractical on testnet/mainnet-sized histories. The **announcement indexer** (`packages/indexer`) closes that gap: run one and point clients at it with `--indexer` / `SHADE_INDEXER`. It stays **advisory**: Horizon remains the source of truth, every scan ends with a Horizon tail, and an unreachable, degraded or stale indexer silently falls back to the full walk, which is still impractical at public-network scale. Configure one, or expect slow cold scans.
- **No BIP-32/44:** HD derivation uses domain-separated SHA-256, not standard BIP-32 paths (those use secp256k1).
- **No view key rotation:** Shared view keys cannot be revoked. Generate new keys to stop a viewer from seeing future payments.
- **Destination account must exist:** The withdrawal destination needs an active Stellar account (1 XLM MBR). Fund it via exchange withdrawal for best privacy.

## Security

- Spend private keys never leave the client
- View keys enable scan-only access (safe to delegate)
- Stealth private keys exist only in memory during withdraw
- Keystore encrypted with AES-256-GCM by default (opt out with `--plaintext`)
- All randomness from `crypto.getRandomValues()`

## License

Apache License 2.0. See [LICENSE](LICENSE).
