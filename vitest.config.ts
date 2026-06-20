import { defineConfig } from "vitest/config";

// Root Vitest config for the Utter monorepo.
//
// Most members (packages/*, services/*) are pure-Node test suites collected by the
// glob below. `apps/studio` adds React component tests (.test.tsx) that need the
// jsdom environment + the @testing-library/jest-dom setup from its package-local
// config; those cannot run under this plain-Node project. So the root suite is a
// Vitest *projects* config: the "node" project collects every pure-Node suite, and
// the studio project delegates to apps/studio/vitest.config.ts so its jsdom +
// setupFiles apply. This keeps the React component tests inside the root
// no-regression gate instead of silently skipping them (the `.test.ts`-only glob
// previously excluded every `.test.tsx`).
//
// The live-RPC chain test (packages/chain) loads .env.local via dotenv in the test
// file itself; the generous timeouts below cover the slow Arc Testnet public RPC.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        // Pure-Node suites across packages/services + the non-React app tests.
        test: {
          name: "node",
          include: [
            "packages/*/test/**/*.test.ts",
            "services/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
          ],
          // apps/studio runs under its own jsdom project (below); exclude it here
          // so its .test.ts suites are not collected twice.
          exclude: ["apps/studio/**", "**/node_modules/**"],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      // apps/studio React component tests run under their own jsdom config.
      "./apps/studio/vitest.config.ts",
    ],
  },
});
