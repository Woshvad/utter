import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/cost test` resolves the
// include glob from this package cwd (Pitfall 7), not the repo root. The cost
// package is pure server-side cost-attribution + price-floor logic surfaced
// through the observability registry; no jsdom.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
