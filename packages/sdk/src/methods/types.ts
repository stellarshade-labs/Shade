import type {
  DeliveryMethod,
  StealthKeys,
  SendReceipt,
  Payment,
  ClaimReceipt,
  ClaimOpts,
  TransactionSigner,
} from '../types.js';

/** Parameters passed to a delivery adapter's `send`. */
export interface AdapterSendParams {
  /** Recipient meta-address (shade:stellar:... or spend:view hex) */
  metaAddress: string;
  /** Amount in whole units */
  amount: number;
  /**
   * Sender's Stellar secret key — OR, when {@link signTransaction} is set, the
   * sender's PUBLIC G-address (the SDK never calls `Keypair.fromSecret` on it).
   */
  senderSecret: string;
  /** Asset to send. Default: native XLM. Format: "CODE:ISSUER" */
  asset?: string;
  /**
   * Optional external signer for the sender leg (Freighter-style). When set,
   * {@link senderSecret} carries the sender's G-address and the adapter
   * delegates signing to this function instead of `Keypair.fromSecret`.
   */
  signTransaction?: TransactionSigner;
}

/**
 * A pluggable delivery method. Each adapter fully owns one way of getting funds
 * to a stealth recipient: how to send, how to discover incoming payments, and
 * how to claim them. The client just wires adapters together per config.
 */
export interface DeliveryAdapter {
  /** The delivery method this adapter implements. */
  readonly method: DeliveryMethod;

  /**
   * Send funds to a stealth recipient using this method.
   *
   * @param params - Recipient, amount, sender secret, and optional asset.
   * @returns The one-time stealth address and delivering transaction hash.
   */
  send(params: AdapterSendParams): Promise<SendReceipt>;

  /**
   * Discover incoming payments for the given keys.
   *
   * @param keys - Recipient stealth keys (needs viewPrivKey + spendPubKey).
   * @param cursor - Opaque per-method resume cursor.
   * @returns Detected payments and the next cursor to persist.
   */
  scan(
    keys: StealthKeys,
    cursor?: string,
    opts?: { suppressClaimedNative?: boolean },
  ): Promise<{ payments: Payment[]; cursor?: string }>;

  /**
   * Claim a previously discovered payment to a destination.
   *
   * @param payment - The payment to claim (from `scan`).
   * @param destination - Destination Stellar G-address.
   * @param opts - Claim options (keys, relay, merge, etc.).
   * @returns The claim transaction hash, amount, and method.
   */
  claim(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt>;
}
