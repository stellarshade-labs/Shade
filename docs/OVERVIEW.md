# Shade — private payments on Stellar

Shade gives every payment its own fresh, unlinkable address. You publish **one** public handle; anyone can pay you, but nobody watching the chain can tell those payments are yours — or that they're related to each other. It's the first implementation of **stealth addresses** on Stellar.

This doc is layered: plain-English first, with a **"For developers"** note under each part for the real names and APIs.

---

## 1. The one-minute version

On a normal blockchain, your address is like a **glass mailbox**: every payment to it is public and permanently tied to you. Reuse it and the whole world sees your balance and history.

Shade gives you a **new mailbox for every single payment** — and only _you_ can tell which mailboxes are yours. You hand out one public "meta-address"; senders use it to compute a brand-new one-time address each time. On-chain those addresses look unrelated to you and to each other.

What Shade **does** hide: _who_ the recipient is. What it **doesn't** hide: that _a_ payment happened, the amount, or the flow of funds on-chain. Privacy is about identity, not making the money invisible.

---

## 2. Two keys, not one (the "dual-key" idea)

Most wallets have one key that does everything. Shade splits your identity into **two** keys, which is what makes safe scanning possible:

- **View key** — lets someone _find_ payments sent to you. It can **see** but **cannot spend**. Safe to hand to a phone, a server, or a watch-only scanning service.
- **Spend key** — required to actually _move_ the money. This one never leaves you.

Your public **meta-address** is just the _public_ halves of those two keys bundled together (it looks like `shade:stellar:...`). You share it freely — on your profile, in a DM, on a business card.

**Why does each key have a public and a private half?**

- The **public** spend + view keys go _into the meta-address you give out_, so a sender can do the math to create your one-time address.
- The **private** spend + view keys stay _with you_: the private view key to **detect** incoming payments, the private spend key to **spend** them.

> **For developers.** This is DKSAP (Dual-Key Stealth Address Protocol) on ed25519. A sender picks random `r`, computes `R = r·G` and the shared secret `S = r·K_view`, then the one-time address `P = K_spend + SHA256(S)·G`. A one-byte **view tag** = `SHA256(S)[0]` makes scanning ~2× faster. You recover the one-time private key as `p = k_spend + SHA256(S) mod L`. The ECDH runs **client-side** (Stellar has no Curve25519 scalar-mult host function in Soroban). Core math lives in `packages/crypto` and has **zero** `@stellar/stellar-sdk` dependency.

---

## 3. Three ways money can reach you (delivery methods)

The same meta-address works with three "delivery methods." They differ in where the money sits and how private it is:

|                       | **pool**                                                                                                                                                                                                                 | **account**                                                                                                                           | **spp**                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Where funds sit       | Shared Soroban **pool contract**, keyed by your stealth key                                                                                                                                                              | A one-time real Stellar account / claimable balance                                                                                   | Reserved slot — _external, not built_ |
| Privacy               | Hides your **identity** — the stealth key and payout are unlinkable to your meta-address without the view key. **Not a mixer:** the deposit and withdraw both name the stealth key, so the money _flow_ stays traceable. | Same identity-hiding, but the one-time account has its own on-chain life (create / merge) and claiming may touch a wallet you control | — _(not a Shade method)_              |
| Assets                | Any SAC token (XLM, USDC, …)                                                                                                                                                                                             | Native XLM or any classic/SAC asset                                                                                                   | —                                     |
| Discovery (both scan) | Scan the contract's **announcements**, with a **view-tag** fast-path (~2×)                                                                                                                                              | Scan **Horizon** for the ephemeral key in a `MemoHash`, then match the derived address (no view tag)                                  | —                                     |
| Claim                 | Signature-verified `withdraw` (no Stellar account needed)                                                                                                                                                                | Sign with the recovered stealth key, or a relayer-sponsored payout                                                                    | —                                     |
| Status                | ✅ Implemented                                                                                                                                                                                                           | ✅ Implemented                                                                                                                        | ⏳ Reserved (external)                |

Rule of thumb: **`pool`** for the best privacy/cost trade-off and any token (you never need a funded account to claim); **`account`** for the simplest path that works with vanilla Horizon tooling. **`spp`** is only a reserved enum slot — a hook for a _separate, external_ private-payments effort if one ever lands; **Shade does not build it** and it isn't implemented.

> **For developers.** `DeliveryMethod = 'pool' | 'account' | 'spp'` (`packages/sdk/src/types.ts`); adapters in `packages/sdk/src/methods/{pool,account,spp}.ts`. `spp` throws `MethodNotAvailableError` for now.

---

## 4. Getting your keys (four ways)

1. **Random** — generate fresh keys. Simple; back them up yourself.
2. **BIP-39 mnemonic** — 12 words you write down; recover your keys on any device.
3. **HD derivation** — keys derived deterministically via domain-separated SHA-256.
4. **From your wallet's signature** — sign one fixed message with your Stellar wallet (e.g. Freighter) and Shade derives your stealth keys from that signature. Same wallet + same app scope → the **same keys every time**, so there's _nothing to store_ and _nothing to back up separately_. This is the "keyless" path.

One trade-off to know for method 4: your wallet effectively _is_ your stealth key backup — if the wallet is compromised, so are the stealth keys. That's the accepted deal for keyless recovery.

> **For developers.** `packages/crypto/src/{keys.ts, hd.ts, derive-signature.ts}`. Wallet derivation: `keysFromWalletSignature(signer, opts)` in `@shade/sdk` (SEP-53 message via `buildKeyDerivationMessage`; determinism is verified by default so a non-canonical signer fails loudly). Scope keys with a matching `{ appId, keyScope }` across every tool that derives them, or you'll get different, non-interoperable keys. In the CLI: `shade keygen --mnemonic | --recover | --from-stellar-secret`.

---

## 5. Signing with your wallet (Freighter)

A web app built on Shade should **never** hold your raw secret key. Instead you pass the SDK a **signer function**, and the browser wallet (Freighter) signs the transaction in its own secure context.

Freighter signs the **sender** and **fee-payer** legs — the ordinary Stellar signatures. The **stealth-key** legs (the one-time keys Shade derives to claim your money) still sign **locally inside the SDK**, because a wallet can't hold a key it never generated. That split is the security boundary: _your wallet never touches the stealth scalar._

```ts
import freighterApi from "@stellar/freighter-api";

const signTransaction = async (xdr: string) => {
  const { signedTxXdr } = await freighterApi.signTransaction(xdr, {
    networkPassphrase,
  });
  return signedTxXdr; // the SDK rebuilds + submits this
};

// Pass a G-address instead of a secret; Freighter does the signing.
await client.send(bob.metaAddress, 100, alicePublicKey, {
  method: "account",
  signTransaction,
});
```

> **For developers.** `TransactionSigner` type + the shared `signTx` helper (`packages/sdk/src/methods/sign.ts`) thread through the four sender/fee-payer legs only; `signWithStealthKey` legs are untouched. Set `feePayerAddress` on a pool claim when using a signer, or you'll get a typed `FeePayerAddressRequiredError`.

---

## 6. Sessions — and why there are no cookies

A web app usually needs to remember you between visits. Shade does this **without cookies**, two ways:

1. **Encrypted session blob.** Your keys + scan progress are encrypted (AES-256-GCM under a password) and saved into whatever storage the app plugs in — `localStorage`, IndexedDB, even a cookie wrapper if the app insists. Shade doesn't care which; it just needs a key/value store.
2. **Re-derive from the wallet (store nothing).** If you used the wallet-signature method (§4), the app doesn't need to store your keys at all — you reconnect your wallet, re-sign the fixed message, and the same keys come back. At most it caches _scan progress_ so you don't re-scan from zero.

> **For developers.** `StealthSession` (`packages/sdk/src/session.ts`): PBKDF2-SHA256 (600k) → AES-256-GCM; public keys stored in the clear, private keys + scan state encrypted. Storage is the `KVStorage` interface (`getItem/setItem/removeItem`), which `window.localStorage` satisfies directly.

---

## 7. The relayer (privacy + claiming into an empty wallet)

There's a chicken-and-egg problem: to claim your money you'd normally need a funded Stellar account to pay the tiny transaction fee — but _using_ a funded account links it to you, undoing the privacy. And a brand-new destination account needs ~1 XLM of reserves just to exist.

The **relayer** solves both. It's the reference service in this repo (`packages/relayer`) that an app or community runs:

- **Fee-bump** (`/relay`) — the relayer pays your withdrawal's fee, so you never reveal a funded account of your own.
- **Reserve fronting / sponsored claims** (`/sponsor`, `/sponsor-claim/*`) — it fronts the ~1 XLM account reserve (+ ~0.5 XLM trustline reserve for tokens) so you can cash out to a **fresh, unfunded address**.

It's metered by a simple **credit** system so it isn't a free-for-all:

1. An app sends the relayer a normal XLM payment.
2. It calls `POST /credit/claim` with the **transaction hash**.
3. The relayer checks Horizon (the payment really happened, to it, from that account, not already claimed) and credits that amount.
4. From then on the relayer supports that app's withdrawals/claims, drawing down the credit.

Two things to be clear about: today the top-up is a **plain Stellar payment** verified by its `txHash` — a private funding rail (an external Stellar private-payments protocol, say) could do the same job later, but none is integrated yet — and there is **no hard-coded/hosted relayer URL**, so "default" just means the reference service you deploy and point your app at.

> **For developers.** Endpoints in `packages/relayer/src/index.ts`; logic in `routes/{credit,sponsor,sponsorClaim}.ts` and `ledger.ts`. Credit-gating is switched on with `RELAYER_REQUIRE_CREDIT=1`. Clients get `SponsoredClaimMismatchError` protection: the SDK re-derives a sponsored claim from your own inputs and refuses to sign if a malicious relayer altered the payout.

| Endpoint                                  | What it does                                                |
| ----------------------------------------- | ----------------------------------------------------------- |
| `GET /health`                             | Status + relayer balance                                    |
| `POST /relay`                             | Fee-bump and submit a withdrawal (privacy)                  |
| `POST /sponsor`                           | Create a one-time stealth account (front the base reserve)  |
| `POST /sponsor-claim/prepare` · `/submit` | Build, then co-sign + submit, a reserve-fronted token claim |
| `POST /credit/claim`                      | Top up credit by proving an XLM payment via `txHash`        |
| `GET /credit/:account`                    | Check a credit balance                                      |

---

## 8. Running it for real — Railway (testnet)

The relayer is a standalone service (no dependency on the crypto package), so it deploys anywhere. It ships **ready** for **Railway** — this is a prepared configuration, not a record of a Railway deployment. (The relayer itself has been exercised against testnet: it fee-bumped the pool withdraw in the 2026-07-17 testnet validation, see §11.)

- `packages/relayer/railway.json` — NIXPACKS build, `npm run start` (`node dist/index.js`), health check on `/health`.
- Fund a testnet account via friendbot, set `RELAYER_SECRET` to its secret and `NETWORK=testnet`, point Railway's root at `packages/relayer`, deploy, and hit `/health`.

Step-by-step is in `packages/relayer/README.md`.

> **Roadmap caveat:** Railway's filesystem is ephemeral, so the JSON credit ledger doesn't survive restarts. That's fine for a testnet demo; a durable store (Postgres/Redis) is the production fix.

---

## 9. For CLI users

The `shade` CLI is the reference tool and a great way to feel the whole flow:

```bash
shade keygen --mnemonic                       # 12-word backup; prints your shade:stellar:... meta-address
shade send <meta-address> 100 --method pool --network testnet   # secret via SHADE_FROM_SECRET or a prompt
shade scan    --network testnet               # find payments sent to you
shade balance --network testnet
shade claim <stealth-addr> <your-address> --fee-payer <secret>  # or --relay <url>, or --sponsored
```

Secrets are read from env vars (`SHADE_FROM_SECRET`, `SHADE_FEE_PAYER`) or an stderr prompt so they don't land in your shell history. Keystores are encrypted by default (AES-256-GCM); opt out with `--plaintext`. Full commands: `keygen`, `address`, `send`, `scan`, `balance`, `claim`, `withdraw`.

---

## 10. For app makers (the SDK)

Two packages:

- **`@shade/crypto`** — pure stealth-address math (keys, scanning, recovery, HD/mnemonic). Zero Stellar dependency; usable anywhere.
- **`@shade/sdk`** — the batteries-included client. Wraps all Horizon/Soroban I/O behind `StealthClient`, so you never touch DKSAP math or transaction XDR.

```ts
import { StealthClient } from "@shade/sdk";

const client = new StealthClient({
  network: "testnet",
  contractId: "C...", // required when the pool method is enabled
  methods: ["pool", "account"],
  relayer: "https://your-relayer.up.railway.app", // optional
});

const bob = StealthClient.keygen(); // share bob.metaAddress ("shade:stellar:...")

await client.send(bob.metaAddress, 100, aliceSecret, { method: "auto" });

const payments = await client.scan(bob); // [{ stealthAddress, amount, asset, method, ... }]
await client.claim(payments[0], bobPublicKey, {
  keys: bob,
  feePayer: feePayerSecret,
});
```

Everything is there: delivery methods, cursor-aware `scanWithCursor`, Freighter signing (§5), encrypted sessions (§6), and **typed errors** (`MethodRequiredError`, `ContractIdRequiredError`, `NoBalanceError`, `DestinationTrustlineError`, …) so your app can branch cleanly on failures.

> **For developers.** `packages/sdk/src/{index.ts, client.ts}` and `packages/sdk/README.md`.

---

## 11. What's real vs. what's roadmap

**Implemented today:** `pool` + `account` delivery, the relayer (fee-bump / sponsor / credit), Freighter external signing, encrypted sessions, and wallet-signature key derivation. The `pool` method has been **validated end-to-end on Stellar testnet** (2026-07-17): deposit → scan → balance → direct withdraw → relayer fee-bumped withdraw, for both native XLM and a classic-asset (USDC) SAC. No testnet contract id is pinned — testnet resets quarterly, so you deploy your own. One honest caveat: the `account` method's discovery does **not** scale on public networks — its scan walks the global Horizon transaction feed, so a cold scan for a fresh recipient is impractical there (the Horizon indexer on the roadmap is the fix). Day-to-day development still runs on the Docker local network.

**On the roadmap (Shade's own work):** an external cryptography audit (so **not for mainnet yet**), a durable credit ledger, a Horizon indexer for faster account-method scans, and a Rust-crate rename. Note: `spp` is **not** on this list — it's a reserved hook for a _separate, external_ private-payments effort, not something Shade is building.

---

## 12. Links

- **Repo:** https://github.com/stellarshade-labs/Shade
- **Deploy the relayer:** `packages/relayer/README.md`
- **SDK reference:** `packages/sdk/README.md`

_Privacy note: Shade hides your identity, not the flow of funds. Timing and amount patterns can still deanonymize you — withdraw at varied times and amounts, and use fresh destination addresses._
