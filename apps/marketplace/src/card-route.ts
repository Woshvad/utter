// card-route.ts - the A2A agent-card route (MKT-01).
//
// A Hono app factory (deps-injected, mirroring services/facilitator createApp +
// data-proxy proxy) exposing GET /:resourceId/.well-known/agent-card.json. The path
// suffix is EXACTLY /.well-known/agent-card.json (Pitfall 5 - never agent.json). The
// route reads the FINALIZED card for a resource from the injected CardSource (the
// identity.agentId from the ERC-8004 mint, health{verified,score} from the Scorer,
// bond{posted,amount} from StakingVault are already resolved in - this route serves
// the finalized projection, it does not author the card).
//
// Before responding it REUSES validateAgentCard to assert the served card is a valid
// A2A v0.3.0 flat card (Pitfall 4 - never re-author the card shape). An unknown
// resource is 404; a non-conformant card is 500 (a malformed card is never served as
// if valid - T-05-06-CARDPATH). Inbound params are decoded/validated before use.
import { Hono } from "hono";
import { validateAgentCard } from "@utter/ai-runtime";

/**
 * The finalized-card source. The marketplace resolves the finalized card for a
 * resource (from the index projection + the published card store); the route only
 * reads it. Returns null for an unknown resource.
 */
export interface CardSource {
  getCard(resourceId: string): Promise<Record<string, unknown> | null>;
}

/** Dependencies for the card app. */
export interface CardAppDeps {
  source: CardSource;
}

/** A bounded, safe resourceId/slug param (decode-before-use, ASVS V5). */
function isSafeParam(value: string): boolean {
  // Slugs/resourceIds are short, hyphen/alnum or 0x-hex. Reject anything else so a
  // crafted param cannot reach the source as a path-traversal or oversized key.
  return value.length > 0 && value.length <= 96 && /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Build the card-serving Hono app. GET /:resourceId/.well-known/agent-card.json
 * serves the finalized, validateAgentCard-valid card for the resource.
 */
export function createCardApp(deps: CardAppDeps): Hono {
  const app = new Hono();

  app.get("/:resourceId/.well-known/agent-card.json", async (c) => {
    const resourceId = c.req.param("resourceId");
    // Decode/validate the param before it reaches the source.
    if (!isSafeParam(resourceId)) return c.json({ error: "bad_resource" }, 400);

    const card = await deps.source.getCard(resourceId);
    if (!card) return c.json({ error: "not_found" }, 404);

    // Never serve a card that is not a conformant A2A v0.3.0 flat card. The route
    // serves the finalized projection; if it is malformed that is a server fault,
    // not a 200 with a bad card (Pitfall 4 / T-05-06-CARDPATH).
    const result = validateAgentCard(card);
    if (!result.valid) return c.json({ error: "invalid_card", details: result.errors }, 500);

    return c.json(card, 200);
  });

  return app;
}
