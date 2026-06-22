// live-create-real.test.ts - OPERATOR-GATED: the STUDIO create path with REAL AI gen.
//
// Drives LiveAdapter.createResource through the REAL selectGenerator (ClaudeGenerator,
// Agent SDK, real ANTHROPIC_API_KEY) + the real four-gate validateBundle + the real
// IndexStore + BuildEventChannel, proving the studio's supply-side create flow works end
// to end with a genuine model-generated bundle (not the scaffold). This is the studio-
// adapter analog of packages/ai-runtime/test/live-generate.test.ts: that proves the
// generator; this proves the studio's create -> validate -> publish -> stream path on top
// of it. The existing live-adapter.test.ts already proves the same flow with the scaffold.
//
// DOUBLE-GATED (UTTER_LIVE_GEN + ANTHROPIC_API_KEY) so the autonomous suite stays offline.
// Run (sourcing the key from .env.local, isolating the Agent SDK config dir so it uses
// the API key not this machine's interactive Claude Code OAuth - see memory
// live-generation-dev-run):
//   set -a; . ./.env.local; set +a
//   CLEAN=$(mktemp -d); CLAUDE_CONFIG_DIR=$(cygpath -w "$CLEAN") \
//   UTTER_LIVE_GEN=1 pnpm --filter @utter/studio exec vitest run test/live-create-real.test.ts
import { describe, it, expect } from "vitest";
import type { PublicClient } from "viem";
import { InMemoryIndexStore } from "@utter/marketplace";
import {
  selectGenerator,
  validateBundle,
  type Bundle,
  type ResourceSpec,
} from "@utter/ai-runtime";
import { LiveAdapter } from "../app/adapter/live";
import { BuildEventChannel } from "../app/adapter/build-channel";
import { runPlaygroundHarness } from "../app/adapter/playground-harness";
import type { ComposeSpec } from "../app/adapter/types";

const LIVE = Boolean(process.env.UTTER_LIVE_GEN && process.env.ANTHROPIC_API_KEY);

/** A stub publicClient: createResource never reads the chain, but LiveDeps requires one. */
function makeStubPublicClient(): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "decimals") return 6;
      if (functionName === "balanceOf") return 25_000_000n;
      throw new Error(`stub: unexpected functionName ${functionName}`);
    },
  } as unknown as PublicClient;
}

// Force the cheapest model unless the operator pinned one; selectGenerator reads
// env.DEFAULT_MODEL. A copy so we never mutate the ambient process env.
const liveEnv = {
  ...process.env,
  DEFAULT_MODEL: process.env.DEFAULT_MODEL ?? "claude-haiku-4-5-20251001",
};
const realGenerate = (spec: ResourceSpec): Promise<Bundle> =>
  selectGenerator(liveEnv).generate(spec);

/** A LiveAdapter wired with the REAL generator + REAL validator (offline store/channel). */
function makeRealLiveAdapter(): LiveAdapter {
  return new LiveAdapter({
    publicClient: makeStubPublicClient(),
    indexStore: new InMemoryIndexStore(),
    buildChannel: new BuildEventChannel(),
    generate: realGenerate,
    validate: validateBundle,
    runPlayground: runPlaygroundHarness,
  });
}

/** A contract-aligned echo ComposeSpec so the real bundle passes all four gates
 *  (createResource throws on a validation failure). All money is base-unit bigint. */
function makeComposeSpec(): ComposeSpec {
  return {
    prompt: "echo the caller's text back with its length",
    pricingModel: "metered",
    basePrice: 10_000n,
    bond: 5_000_000n,
    payout: "0x1111111111111111111111111111111111111111",
  };
}

describe.skipIf(!LIVE)("studio create flow with REAL AI generation (operator-gated)", () => {
  it(
    "createResource generates a real bundle, validates it, publishes + streams to Live",
    async () => {
      const adapter = makeRealLiveAdapter();

      // THE create call: real model generation + real four-gate validation behind it.
      const { resourceId, eventsUrl } = await adapter.createResource(makeComposeSpec());
      expect(resourceId).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(eventsUrl).toBe(`/resources/${resourceId}/events`);

      // Published to the shared index: visible in discovery + detail.
      const cards = await adapter.listMarketplace({});
      expect(cards.map((c) => c.resourceId)).toContain(resourceId);
      const detail = await adapter.getResourceDetail(resourceId);
      expect(detail.resourceId).toBe(resourceId);
      expect(detail.pricing.base).toBeTruthy();

      // The build stream drains Generate..Live and terminates (no throw / no hang).
      const stages: string[] = [];
      for await (const ev of adapter.subscribeBuildEvents(resourceId)) stages.push(ev.stage);
      expect(stages[0]).toBe("Generate");
      expect(stages.at(-1)).toBe("Live");
      console.log(
        `[studio-live-create] real bundle published as ${resourceId.slice(0, 14)}...  ` +
          `stages=${stages.join(">")}`,
      );
    },
    180_000,
  );
});
