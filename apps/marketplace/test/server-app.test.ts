// server-app.test.ts - the marketplace host wiring (MKT-01/02).
//
// createMarketplaceApp mounts the card route over a CardSource backed by the CardStore.
// A resource whose finalized card was persisted to the store serves a 200 at exactly
// /.well-known/agent-card.json; an unknown resource serves a 404 (the store is the only
// source the card route reads). The card route still re-validates before serving.
import { describe, it, expect } from "vitest";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import {
  InMemoryIndexStore,
  InMemoryCardStore,
  InMemoryModerationStore,
  createPublishPipeline,
  type Hex,
} from "../src/index.js";
import { createMarketplaceApp } from "../src/server";
import { createPublishPipelineDeps } from "../src/publish-deps";
import type { CardSource } from "../src/card-route";

const RESOURCE = `0x${"a7".repeat(32)}` as Hex;

// A finalized card built the way the publish pipeline produces PublishResult.card:
// the base card plus the minted identity, the probe health, and the bond block.
function finalizedCard(): Record<string, unknown> {
  const card = buildAgentCard({
    prompt: "Return the current weather for a city",
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  return {
    ...card,
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "42" },
    health: { verified: true, score: null },
    bond: { posted: true, amount: "2000000" },
  };
}

// Wire the app deps the same way buildDepsFromEnv does: the CardSource reads the
// finalized card from the CardStore (null -> 404 via the card route).
function appWith(cardStore: InMemoryCardStore) {
  const indexStore = new InMemoryIndexStore();
  const moderationStore = new InMemoryModerationStore();
  const cardSource: CardSource = {
    async getCard(resourceId) {
      return (await cardStore.get(resourceId as Hex)) ?? null;
    },
  };
  const publishPipeline = createPublishPipeline(
    createPublishPipelineDeps({}, { indexStore, cardStore, moderationStore }),
  );
  return createMarketplaceApp({ indexStore, cardStore, cardSource, publishPipeline });
}

describe("createMarketplaceApp - card route over a pre-seeded CardStore", () => {
  it("returns 200 with the finalized card for a published resource", async () => {
    const cardStore = new InMemoryCardStore();
    const card = finalizedCard();
    // The card we seed is the same finalized card validateAgentCard accepts.
    expect(validateAgentCard(card).valid).toBe(true);
    await cardStore.put(RESOURCE, card);

    const app = appWith(cardStore);
    const res = await app.request(`/${RESOURCE}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(card);
    expect((body.identity as { agentId: string }).agentId).toBe("42");
  });

  it("returns 404 for an unknown resourceId (store empty for it)", async () => {
    const app = appWith(new InMemoryCardStore());
    const res = await app.request(`/${RESOURCE}/.well-known/agent-card.json`);
    expect(res.status).toBe(404);
  });
});
