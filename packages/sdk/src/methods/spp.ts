import { MethodNotAvailableError } from '../errors.js';
import type { StealthKeys, Payment, ClaimReceipt, ClaimOpts } from '../types.js';
import type { DeliveryAdapter, AdapterSendParams } from './types.js';

const SPP_MESSAGE =
  "the 'spp' method is reserved for future Stellar Private Payments integration";

/**
 * Reserved adapter slot for Stellar Private Payments (SPP).
 *
 * SPP is the Nethermind ZK shielded-pool research prototype (testnet-only
 * today). This adapter intentionally implements the full {@link DeliveryAdapter}
 * surface but every method throws {@link MethodNotAvailableError}. The slot
 * exists so applications can opt into SPP later — by adding `'spp'` to
 * `ClientConfig.methods` — with ZERO API changes: the same `send`/`scan`/`claim`
 * calls simply start routing through a real SPP implementation once it lands.
 */
export class SppAdapter implements DeliveryAdapter {
  readonly method = 'spp' as const;

  /** @throws {MethodNotAvailableError} Always — SPP is not yet implemented. */
  async send(_params: AdapterSendParams): Promise<never> {
    throw new MethodNotAvailableError(SPP_MESSAGE);
  }

  /** @throws {MethodNotAvailableError} Always — SPP is not yet implemented. */
  async scan(
    _keys: StealthKeys,
    _cursor?: string,
  ): Promise<{ payments: Payment[]; cursor?: string }> {
    throw new MethodNotAvailableError(SPP_MESSAGE);
  }

  /** @throws {MethodNotAvailableError} Always — SPP is not yet implemented. */
  async claim(
    _payment: Payment,
    _destination: string,
    _opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    throw new MethodNotAvailableError(SPP_MESSAGE);
  }
}
