import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/orchestrator test` resolves
// the include glob from this package cwd (Pitfall 7), not the repo root. The
// orchestrator is pure server-side control-plane logic (placement, warm pool,
// idle reaper) that schedules the Phase 3 SandboxRunner; no jsdom.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
