/**
 * Resolve the announcement-indexer URL for a command: the `--indexer` flag
 * wins, then the `SHADE_INDEXER` env var, then none. Values are trimmed and
 * an empty/whitespace value falls through the chain (ultimately to
 * `undefined`), so truthiness keeps meaning "an indexer is configured".
 */
export function resolveIndexer(flag?: string): string | undefined {
  const fromFlag = flag?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.SHADE_INDEXER?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}
