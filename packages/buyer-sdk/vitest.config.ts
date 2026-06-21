import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/buyer-sdk test` resolves
// the include glob from this package cwd (Pitfall 6), not the repo root. No jsdom:
// the buyer SDK is pure server-side (the pay loop + the MCP stdio server).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
