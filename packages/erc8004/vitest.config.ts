import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/erc8004 test` resolves the
// include glob from this package cwd (Pitfall 8), not the repo root.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
