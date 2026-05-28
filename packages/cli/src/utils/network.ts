import chalk from 'chalk';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  verbose?: boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffFactor = 2,
    verbose = false
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (verbose && attempt > 1) {
        console.log(chalk.gray(`  Retry attempt ${attempt}/${maxAttempts} for ${operation}...`));
      }
      return await fn();
    } catch (error: any) {
      lastError = error;

      const isTimeout = error.message?.includes('timeout') ||
                       error.message?.includes('ETIMEDOUT') ||
                       error.message?.includes('ECONNREFUSED');

      const isRetriable = isTimeout ||
                         error?.response?.status === 503 ||
                         error?.response?.status === 504 ||
                         error?.response?.status === 429;

      if (!isRetriable || attempt === maxAttempts) {
        throw error;
      }

      if (verbose) {
        console.log(chalk.yellow(`  ${operation} failed (attempt ${attempt}/${maxAttempts}): ${error.message}`));
        console.log(chalk.gray(`  Waiting ${delay}ms before retry...`));
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw lastError || new Error(`${operation} failed after ${maxAttempts} attempts`);
}

export function formatError(error: any): string {
  if (error?.response?.data?.extras?.result_codes) {
    const codes = error.response.data.extras.result_codes;
    if (codes.transaction) {
      return `Transaction failed: ${codes.transaction}`;
    }
    if (codes.operations?.length > 0) {
      return `Operation failed: ${codes.operations.join(', ')}`;
    }
  }

  if (error?.response?.status === 404) {
    return 'Account not found on network';
  }

  if (error?.response?.status === 400) {
    return 'Invalid request format';
  }

  if (error.code === 'ECONNREFUSED') {
    return 'Cannot connect to network (is the node running?)';
  }

  if (error.code === 'ETIMEDOUT') {
    return 'Network request timed out';
  }

  return error.message || 'Unknown error';
}

export function validateMetaAddress(metaAddress: string): { spendPubKey: Buffer; viewPubKey: Buffer } | null {
  const parts = metaAddress.split(':');
  if (parts.length !== 2) {
    return null;
  }

  try {
    if (!parts[0] || !parts[1]) {
      return null;
    }

    const spendPubKey = Buffer.from(parts[0], 'hex');
    const viewPubKey = Buffer.from(parts[1], 'hex');

    if (spendPubKey.length !== 32 || viewPubKey.length !== 32) {
      return null;
    }

    return { spendPubKey, viewPubKey };
  } catch {
    return null;
  }
}