import { defineConfig } from "vitest/config";

// Package-local Vitest config so the include glob resolves from this package cwd
// (mirrors the other packages). Pure server-side: the generator is fs + string work,
// no jsdom, no chain, no network (the one fetch path is exercised via an injected fetcher).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
