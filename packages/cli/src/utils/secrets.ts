import { promptPassword } from './keystore.js';

/**
 * Resolve a secret from (in order) an inline flag, an environment variable, or
 * an stderr prompt.
 *
 * Passing secrets as CLI flags leaks them into shell history (and `ps` output),
 * so the env-var and prompt paths are the recommended way to supply a sender or
 * fee-payer secret; the flag is retained only for back-compat and scripting. The
 * prompt reads from stderr and does not echo keystrokes.
 *
 * @param flagValue - The inline flag value, if the user passed one.
 * @param envVar - Environment variable name to read when the flag is absent.
 * @param promptLabel - Prompt text shown on stderr when neither is present.
 * @returns The resolved secret, or `undefined` if all sources are empty.
 */
export async function resolveSecret(
  flagValue: string | undefined,
  envVar: string,
  promptLabel: string,
): Promise<string | undefined> {
  if (flagValue) return flagValue;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const entered = await promptPassword(promptLabel);
  return entered || undefined;
}
