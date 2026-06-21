import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/facilitator test` resolves
// the suite from this member's cwd (Pitfall 7: the documented per-member cwd quirk
// where a filtered run finds "No test files" without a local config). The root
// `projects` glob still collects `services/*/test/**` into the monorepo
// no-regression gate; this config only makes the filtered invocation self-contained.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
