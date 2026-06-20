import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/observability test` resolves
// the include glob from this package cwd (Pitfall 8), not the repo root. No jsdom:
// the observability package is pure server-side metrics/logs/alerts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
