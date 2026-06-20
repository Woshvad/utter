import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/studio test` resolves the
// include glob from this package cwd (Pitfall 8), not the repo root. jsdom is the
// environment for the React component tests the feature waves add; the `(x)` glob
// suffix collects .test.tsx too.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts?(x)"],
    environment: "jsdom",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
