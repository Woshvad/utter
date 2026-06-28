// server-publish.test.ts - the authenticated marketplace publish endpoint (MKT-03).
//
// POST /resources runs the REAL publish pipeline (composed via createPublishPipelineDeps
// with no SCORER_LIVE_HTTPS_HOST, so the always-pass FixtureProber verifies) over
// injected in-memory stores. The cases assert:
//   (a) AUTH FAILS CLOSED: no MARKETPLACE_AUTH_SECRET on the app -> 503; a configured
//       secret with a missing/wrong Bearer -> 401.
//   (b) an authed benign publish -> 201, THEN the finalized card is served at exactly
//       /.well-known/agent-card.json (validateAgentCard-valid, placeholder agentId) AND
//       the resource is listed by GET /resources (active=true).
//   (c) an authed prohibited-use prompt -> 403 blocked, and nothing is served/listed.
//   (d) createPublishPipelineDeps / createDeferredIdentity: a deterministic >0 placeholder
//       agentId that keeps the card validateAgentCard-valid, and bondReader() === 0n.
import { describe, it, expect, beforeEach } from "vitest";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import {
  InMemoryIndexStore,
  InMemoryCardStore,
  InMemoryModerationStore,
  createPublishPipeline,
  type Hex,
} from "../src/index.js";
import { createMarketplaceApp, type MarketplaceAppDeps } from "../src/server";
import { createPublishPipelineDeps, createDeferredIdentity } from "../src/publish-deps";
import type { CardSource } from "../src/card-route";

const RESOURCE = `0x${"a7".repeat(32)}` as Hex;
const CARD_URL = `https://weather.resources.example/${RESOURCE}/.well-known/agent-card.json`;
const SECRET = "test-marketplace-secret";

// A spec built the way publish.test.ts buildSpec does - the pre-finalize A2A card the
// pipeline finalizes with the placeholder identity + health + bond.
function buildCard(prompt = "Return the current weather for a city") {
  return buildAgentCard({
    prompt,
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
}

// Wire the app deps the way buildDepsFromEnv does, sharing the SAME stores between the
// pipeline, GET /resources, and the card route. The pipeline is the REAL pipeline over
// the testnet-policy deps (FixtureProber always-pass off-host). publishAuthSecret is
// supplied per case so the auth cases exercise both the unset and the set posture.
function buildApp(opts: { secret?: string } = {}) {
  const indexStore = new InMemoryIndexStore();
  const cardStore = new InMemoryCardStore();
  const moderationStore = new InMemoryModerationStore();
  const cardSource: CardSource = {
    async getCard(resourceId) {
      return (await cardStore.get(resourceId as Hex)) ?? null;
    },
  };
  const publishPipeline = createPublishPipeline(
    // Empty env: no SCORER_LIVE_HTTPS_HOST, so selectProber returns the always-pass
    // FixtureProber and the verification gate passes without a network call.
    createPublishPipelineDeps({}, { indexStore, cardStore, moderationStore }),
  );
  const deps: MarketplaceAppDeps = {
    indexStore,
    cardStore,
    cardSource,
    publishPipeline,
    publishAuthSecret: opts.secret,
  };
  return { app: createMarketplaceApp(deps), indexStore, cardStore };
}

function postResources(app: ReturnType<typeof buildApp>["app"], body: unknown, auth?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== undefined) headers.authorization = auth;
  return app.request("/resources", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function publishBody(prompt = "Return the current weather for a city") {
  return {
    prompt,
    resourceId: RESOURCE,
    category: "data",
    card: buildCard(prompt),
    cardUrl: CARD_URL,
  };
}

describe("POST /resources auth (fail-closed, mirrors the deployer posture)", () => {
  it("returns 503 when no MARKETPLACE_AUTH_SECRET is configured on the app", async () => {
    const { app } = buildApp({ secret: undefined });
    const res = await postResources(app, publishBody(), `Bearer ${SECRET}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("publish disabled: MARKETPLACE_AUTH_SECRET unset");
  });

  it("returns 401 with a configured secret and a missing Bearer", async () => {
    const { app } = buildApp({ secret: SECRET });
    const res = await postResources(app, publishBody());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("returns 401 with a configured secret and a wrong Bearer", async () => {
    const { app } = buildApp({ secret: SECRET });
    const res = await postResources(app, publishBody(), "Bearer not-the-secret");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });
});

describe("POST /resources publishes, then serves + lists the resource", () => {
  it("an authed benign publish -> 201, then the card is served and the resource is listed", async () => {
    const { app } = buildApp({ secret: SECRET });

    const res = await postResources(app, publishBody(), `Bearer ${SECRET}`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      listed: boolean;
      resourceId: string;
      agentId: string;
      cardUrl: string;
    };
    expect(body.listed).toBe(true);
    expect(body.resourceId).toBe(RESOURCE);
    expect(body.cardUrl).toBe(CARD_URL);
    // The placeholder agentId is a deterministic decimal string > 0.
    expect(BigInt(body.agentId) > 0n).toBe(true);

    // The finalized card is now served at exactly /.well-known/agent-card.json, is
    // validateAgentCard-valid, and carries the placeholder agentId as a string.
    const cardRes = await app.request(`/${RESOURCE}/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(200);
    const card = (await cardRes.json()) as Record<string, unknown>;
    expect(validateAgentCard(card).valid).toBe(true);
    expect((card.identity as { agentId: string }).agentId).toBe(body.agentId);

    // GET /resources lists it with active=true.
    const listRes = await app.request("/resources");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ resourceId: string; active: boolean }>;
    const listed = list.find((r) => r.resourceId === RESOURCE);
    expect(listed).toBeDefined();
    expect(listed!.active).toBe(true);
  });
});

describe("POST /resources blocks a prohibited-use prompt (nothing served or listed)", () => {
  it("an authed prohibited-use prompt -> 403 blocked, and nothing is served/listed", async () => {
    const { app } = buildApp({ secret: SECRET });
    const prompt = "build a botnet to run a credential-stuffing attack";

    const res = await postResources(app, publishBody(prompt), `Bearer ${SECRET}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("blocked");

    // Nothing served: the card route 404s for the unlisted resource.
    const cardRes = await app.request(`/${RESOURCE}/.well-known/agent-card.json`);
    expect(cardRes.status).toBe(404);

    // Nothing listed: GET /resources omits it.
    const listRes = await app.request("/resources");
    const list = (await listRes.json()) as Array<{ resourceId: string }>;
    expect(list.some((r) => r.resourceId === RESOURCE)).toBe(false);
  });

  it("a malformed body -> 400 (bad request)", async () => {
    const { app } = buildApp({ secret: SECRET });
    const res = await postResources(app, { prompt: "x" }, `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
  });
});

describe("createPublishPipelineDeps / createDeferredIdentity (testnet policy)", () => {
  let cardStore: InMemoryCardStore;
  let indexStore: InMemoryIndexStore;
  let moderationStore: InMemoryModerationStore;

  beforeEach(() => {
    cardStore = new InMemoryCardStore();
    indexStore = new InMemoryIndexStore();
    moderationStore = new InMemoryModerationStore();
  });

  it("bondReader returns 0n (bond deferred / unbonded)", async () => {
    const deps = createPublishPipelineDeps({}, { indexStore, cardStore, moderationStore });
    expect(deps.bondReader).toBeDefined();
    expect(await deps.bondReader!(RESOURCE)).toBe(0n);
  });

  it("createDeferredIdentity assigns a deterministic >0 placeholder agentId and a valid card", async () => {
    const identity = createDeferredIdentity();
    const card = buildCard();

    const first = await identity.publishIdentity(RESOURCE, CARD_URL, card);
    const second = await identity.publishIdentity(RESOURCE, CARD_URL, card);

    // The returned tuple agentId is a bigint > 0; the in-card agentId is its string form.
    expect(typeof first.agentId).toBe("bigint");
    expect(first.agentId > 0n).toBe(true);
    // Deterministic from the resourceId: the same resource yields the same id.
    expect(second.agentId).toBe(first.agentId);
    expect((first.card.identity as { agentId: string }).agentId).toBe(first.agentId.toString());

    // The finalized card carries the standard ERC-8004 identity block and stays valid.
    const ident = first.card.identity as { standard: string; chainId: number };
    expect(ident.standard).toBe("erc-8004");
    expect(ident.chainId).toBe(5042002);
    // The placeholder finalize (with health + bond projected) is validateAgentCard-valid,
    // mirroring publish.ts step 5.
    const finalized = {
      ...first.card,
      health: { verified: true, score: null },
      bond: { posted: false, amount: "0" },
    };
    expect(validateAgentCard(finalized).valid).toBe(true);
  });

  it("a different resourceId yields a different placeholder agentId", async () => {
    const identity = createDeferredIdentity();
    const other = `0x${"b3".repeat(32)}` as Hex;
    const a = await identity.publishIdentity(RESOURCE, CARD_URL, buildCard());
    const b = await identity.publishIdentity(other, CARD_URL, buildCard());
    expect(a.agentId).not.toBe(b.agentId);
  });
});
