import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  // @shade/crypto is never published (see packages/sdk/tsup.config.ts). Embed it
  // in the bundle so the globally-installed CLI is self-contained.
  //
  // tsconfig.build.json resolves @shade/crypto from its source, NOT from
  // node_modules/@shade/crypto -> dist. That matters here: `npm run build
  // --workspaces` builds packages alphabetically, so packages/cli builds BEFORE
  // packages/crypto — crypto's dist may not exist yet when this runs.
  tsconfig: 'tsconfig.build.json',
  noExternal: ['@shade/crypto'],
  // crypto's own runtime deps (@noble/*, @scure/bip39) and everything else
  // (stellar-shade, commander, chalk, ...) stay external and are declared in
  // package.json "dependencies".
  sourcemap: true,
  clean: true,
  // No dts: the CLI is an executable, not an importable library. The leading
  // `#!/usr/bin/env node` shebang in src/index.ts is preserved by tsup and the
  // output is marked executable.
});
