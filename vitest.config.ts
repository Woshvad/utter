import { defineConfig } from "vitest/config";

// Root Vitest config for the Utter monorepo.
// The live-RPC chain test (packages/chain) loads .env.local via dotenv in the
// test file itself; this config only sets the include glob and a generous
// network timeout (Arc Testnet public RPC can be slow / rate-limited).
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
