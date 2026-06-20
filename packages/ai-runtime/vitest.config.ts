import { defineConfig } from "vitest/config";

// Package-local Vitest config so `pnpm --filter @utter/ai-runtime test` (the
// per-task sampling command in 04-VALIDATION) resolves this package's tests when
// invoked from the package cwd. The root vitest.config glob is root-relative and
// finds nothing from a package directory; this scopes the include to this package
// only. The repo-wide run (`pnpm -r test` / root `vitest run`) is unaffected: it
// uses the root config and still discovers `packages/*/test/**`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
