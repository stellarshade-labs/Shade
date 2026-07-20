import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Declaration emit needs a tsconfig whose "paths" do NOT redirect
  // @shade/crypto at the workspace source; see tsconfig.build.json.
  tsconfig: 'tsconfig.build.json',
  // `resolve` makes the declaration bundler inline @shade/crypto's types too.
  // Without it the .d.ts keeps `import { StealthKeys } from '@shade/crypto'`
  // (src/index.ts re-exports it as RawStealthKeys) — a module consumers cannot
  // install, so their typecheck would break even though the runtime bundle is
  // self-contained.
  // The second pattern matters: once '@shade/crypto' resolves, its own barrel
  // re-exports './types.js', and that relative id no longer matches the package
  // name — the declaration bundler would leave it external and emit a dangling
  // './types.js' reference. Matching the resolved path pulls the leaf in too.
  dts: { resolve: ['@shade/crypto', /packages[\\/]crypto[\\/]/] },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Embed the internal workspace package into the bundle so consumers don't
  // need @shade/crypto from the registry — it is never published. All other
  // deps stay external and are declared in package.json "dependencies";
  // that is why @noble/curves and @scure/bip39 (crypto's own runtime deps)
  // are listed there rather than in @shade/crypto alone.
  noExternal: ['@shade/crypto'],
});
