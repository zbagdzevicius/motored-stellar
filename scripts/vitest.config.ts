import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests cover the pure parts only. Live testnet runs are manual (npm run testnet:*).
// Workspace packages resolve to their TypeScript sources, so tests do not need a prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@motored-stellar/reconciler': fileURLToPath(new URL('../packages/reconciler/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
