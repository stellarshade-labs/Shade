import { NoHealthyRelayerError } from '@shade/sdk';
import chalk from 'chalk';

/** Split one `--relay` value on commas, trimming and dropping empties. */
export function splitRelayList(value: string): string[] {
  return value
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * Commander accumulator for `--relay`: the flag is repeatable AND each value
 * may itself be comma-separated, so `--relay a,b --relay c` yields [a, b, c].
 */
export function collectRelay(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), ...splitRelayList(value)];
}

/**
 * Resolve the relayer list for a command: `--relay` values win, then the
 * comma-separated `SHADE_RELAYERS` env var, then none. Returns `undefined`
 * (never `[]`) when no relayer is configured, so truthiness checks keep
 * meaning "relaying is on".
 */
export function resolveRelays(flag?: string | string[]): string[] | undefined {
  const flagList =
    flag === undefined
      ? undefined
      : (Array.isArray(flag) ? flag : [flag]).flatMap(splitRelayList);
  if (flagList && flagList.length > 0) return flagList;
  const env = process.env.SHADE_RELAYERS;
  if (env) {
    const envList = splitRelayList(env);
    if (envList.length > 0) return envList;
  }
  return undefined;
}

/**
 * Print a per-candidate rejection table for a failed relayer selection — the
 * error's own message carries the same facts semicolon-joined, but one line
 * per relayer is what a human debugging a relayer list actually wants.
 */
export function printNoHealthyRelayer(err: NoHealthyRelayerError): void {
  console.error(chalk.red('No healthy relayer:'));
  for (const [url, reason] of Object.entries(err.candidates)) {
    console.error(chalk.gray(`  ${url} — ${reason}`));
  }
}
