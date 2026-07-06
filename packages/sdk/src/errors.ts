import type { DeliveryMethod } from './types.js';

/**
 * Thrown when `send()` is called without an explicit delivery method.
 * The SDK deliberately has NO implicit default: the app must choose a method
 * (or `'auto'`) on every send so the privacy trade-off is always a conscious one.
 */
export class MethodRequiredError extends Error {
  constructor() {
    super(
      "A delivery method is required. Pass opts.method: 'pool' | 'account' | 'auto'.",
    );
    this.name = 'MethodRequiredError';
  }
}

/**
 * Thrown when a requested delivery method is not present in the client's
 * configured `methods` list.
 */
export class MethodNotEnabledError extends Error {
  constructor(method: DeliveryMethod) {
    super(
      `Delivery method '${method}' is not enabled. Add it to ClientConfig.methods to use it.`,
    );
    this.name = 'MethodNotEnabledError';
  }
}

/**
 * Thrown when a delivery method exists but cannot service the request
 * (e.g. a non-native asset over the account method, or the reserved spp method).
 */
export class MethodNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MethodNotAvailableError';
  }
}

/**
 * Thrown when an account-method XLM send is below the protocol minimum
 * (amount must be strictly greater than 1 XLM to fund a new stealth account).
 */
export class MinimumAmountError extends Error {
  constructor(amount: number) {
    super(
      `Account sends require an amount strictly greater than 1 XLM (got ${amount}).`,
    );
    this.name = 'MinimumAmountError';
  }
}
