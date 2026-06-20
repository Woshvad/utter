// card-route.test.ts - the A2A card route at /.well-known/agent-card.json (MKT-01).
//
// The route serves the FINALIZED card (identity.agentId from the ERC-8004 mint,
// health{verified,score} from the Scorer, bond{posted,amount} from StakingVault)
// at EXACTLY /.well-known/agent-card.json (Pitfall 5 - never agent.json). It REUSES
// validateAgentCard to assert the served card is a valid A2A v0.3.0 flat card before
// responding (Pitfall 4 - never re-author the card shape). An unknown resource is 404.
import { describe, it, expect } from "vitest";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import { createCardApp, type CardSource } from "../src/card-route";

const SPEC = {
  prompt: "weather data for a city",
  pricing: { model: "metered" as const, base: "1000", perKB: "10", max: "100000" },
};

// A finalized card: build the base card, then fill the Phase 5 placeholders the way
// the publish pipeline does (agentId mint, Scorer health, StakingVault bond).
function finalizedCard(): Record<string, unknown> {
  const card = buildAgentCard(SPEC);
  return {
    ...card,
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "42" },
    health: { verified: true, score: 0.99 },
    bond: { posted: true, amount: "1000000" },
  };
}

function source(cards: Record<string, Record<string, unknown>>): CardSource {
  return {
    async getCard(resourceId: string) {
      return cards[resourceId] ?? null;
    },
  };
}

const KNOWN = "weather-api";

describe("createCardApp - GET /.well-known/agent-card.json (MKT-01)", () => {
  it("serves the finalized card at exactly /.well-known/agent-card.json (200, json)", async () => {
    const app = createCardApp({ source: source({ [KNOWN]: finalizedCard() }) });
    const res = await app.request(`/${KNOWN}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.protocolVersion).toBe("0.3.0");
  });

  it("the served card passes validateAgentCard (v0.3.0 flat shape)", async () => {
    const app = createCardApp({ source: source({ [KNOWN]: finalizedCard() }) });
    const res = await app.request(`/${KNOWN}/.well-known/agent-card.json`);
    const body = await res.json();
    expect(validateAgentCard(body).valid).toBe(true);
  });

  it("serves the finalized identity/health/bond (not placeholders)", async () => {
    const app = createCardApp({ source: source({ [KNOWN]: finalizedCard() }) });
    const res = await app.request(`/${KNOWN}/.well-known/agent-card.json`);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body.identity.agentId).toBe("42");
    expect(body.health.verified).toBe(true);
    expect(body.health.score).toBe(0.99);
    expect(body.bond.posted).toBe(true);
  });

  it("returns 404 for an unknown resource", async () => {
    const app = createCardApp({ source: source({}) });
    const res = await app.request(`/unknown-xyz/.well-known/agent-card.json`);
    expect(res.status).toBe(404);
  });

  it("refuses to serve an invalid (non-conformant) card (500, never a bad card)", async () => {
    // A card missing the required x402 block must not be served as if valid.
    const app = createCardApp({ source: source({ [KNOWN]: { protocolVersion: "0.3.0" } }) });
    const res = await app.request(`/${KNOWN}/.well-known/agent-card.json`);
    expect(res.status).toBe(500);
  });

  it("never serves the path agent.json (Pitfall 5)", async () => {
    const app = createCardApp({ source: source({ [KNOWN]: finalizedCard() }) });
    const res = await app.request(`/${KNOWN}/.well-known/agent.json`);
    expect(res.status).toBe(404);
  });
});
