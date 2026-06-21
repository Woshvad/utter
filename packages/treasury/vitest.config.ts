import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/treasury test` resolves the
// include glob from this package cwd (Pitfall 7), not the repo root. The treasury
// package is pure server-side payout/swap/cross-chain logic (PayoutRouter,
// StableFxAdapter, CctpFunder); no jsdom.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
