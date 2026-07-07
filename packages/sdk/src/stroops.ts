/**
 * Exact decimal <-> stroop conversions.
 *
 * A stroop is 1e-7 of a Stellar asset unit. Converting whole-unit amounts with
 * `Math.round(amount * 1e7)` or `Number(stroops) / 1e7` silently loses precision
 * once the magnitude exceeds `Number.MAX_SAFE_INTEGER` stroops (~9.007e8 XLM) —
 * a float can no longer represent every integer stroop, so large sends drift.
 * These helpers keep the value as a `bigint` count of stroops end to end and
 * only render a string at the display edge, so no amount ever round-trips
 * through a lossy float.
 */

const STROOP_DECIMALS = 7;
const STROOPS_PER_UNIT = 10n ** BigInt(STROOP_DECIMALS);

/**
 * Parse a decimal amount string (whole units, e.g. `"100.5"`) into an exact
 * `bigint` count of stroops.
 *
 * @param amount - Decimal string with at most 7 fractional digits.
 * @throws {Error} If the input is not a non-negative decimal, or carries more
 *   than 7 fractional digits (which cannot be represented in stroops).
 */
export function parseStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid amount "${amount}" — expected a non-negative decimal number.`,
    );
  }

  const parts = trimmed.split('.');
  const wholePart = parts[0] ?? '0';
  const fracPartRaw = parts[1] ?? '';
  if (fracPartRaw.length > STROOP_DECIMALS) {
    throw new Error(
      `Amount "${amount}" has more than ${STROOP_DECIMALS} decimal places ` +
        '(smaller than one stroop).',
    );
  }

  const fracPart = fracPartRaw.padEnd(STROOP_DECIMALS, '0');
  return BigInt(wholePart) * STROOPS_PER_UNIT + BigInt(fracPart);
}

/**
 * Convert a `number` amount (whole units) into exact stroops, rejecting values
 * that cannot be represented exactly (non-finite, negative, or with sub-stroop
 * fractional precision). Prefer {@link parseStroops} when the amount originates
 * as a string; this exists for the numeric SDK surface.
 *
 * @param amount - Non-negative finite whole-unit amount.
 */
export function numberToStroops(amount: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid amount ${amount} — expected a non-negative number.`);
  }
  return parseStroops(amount.toString());
}

/**
 * Render an exact `bigint` stroop count back to a fixed 7-decimal string
 * (e.g. `12345000000n` -> `"1234.5000000"`). Never goes through a float.
 *
 * @param stroops - Stroop count (non-negative).
 */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = abs % STROOPS_PER_UNIT;
  const fracStr = frac.toString().padStart(STROOP_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}
