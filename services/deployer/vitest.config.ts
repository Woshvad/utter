import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/deployer test` resolves the
// include glob from THIS package cwd, not the repo root. Without it, a filtered run
// has no local config and falls through to the root vitest.config.ts, whose
// `projects` array delegates to "./apps/studio/vitest.config.ts"; that relative path
// is resolved against the package cwd (services/deployer/apps/studio/vitest.config.ts),
// which does not exist, so Vitest fails at startup ("Projects definition references a
// non-existing file"). This local config short-circuits that: the filtered run loads
// it directly and runs ONLY this package's tests. The root `pnpm exec vitest run`
// still collects these tests via its own globs, so the no-regression gate is
// unaffected (mirrors packages/data-proxy/vitest.config.ts, Pitfall 8).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
