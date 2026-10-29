import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources, so the example and its
// tests run without building every package to dist/ first.
const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@motored-stellar/claims': src('claims'),
      '@motored-stellar/escrow': src('escrow'),
      '@motored-stellar/eurc': src('eurc'),
      '@motored-stellar/ramps': src('ramps'),
      '@motored-stellar/reconciler': src('reconciler'),
      '@motored-stellar/wallets': src('wallets'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
