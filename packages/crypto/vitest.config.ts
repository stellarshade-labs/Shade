import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Several suites run thousands of curve operations in one test or hook
    // (stress loops, the 10k-announcement scan fixture). Vitest's 5s/10s
    // defaults are a wall-clock limit, not a correctness check, and trip on
    // slower machines; the explicit performance thresholds live in the tests.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
