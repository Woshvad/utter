import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/data-proxy test` resolves
// the include glob from this package cwd (Pitfall 8), not the repo root. Without
// it, a filtered run inherits the root glob (packages/*/test/**) resolved against
// this package cwd and finds zero files. The root `pnpm exec vitest run` still
// collects these tests via the root config; this only makes the filtered run work.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
