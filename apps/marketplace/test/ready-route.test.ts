// ready-route suite (Provisioning track, subtask 4): GET /health (a constant liveness
// check) + GET /ready (the store-aware readiness probe) on the marketplace host.
//
// Fully offline + in-process: createMarketplaceApp driven through app.request. The only
// varying dep is storeProbe:
//   - /health -> 200 {ok:true,service:'marketplace'} (constant; never calls the probe)
//   - /ready with a resolving probe -> 200 {ready:true}
//   - /ready with a THROWING probe (message carries a fake secret) -> 503 {ready:false},
//     VALUE-FREE (no 'secret' / 'postgres://' in the body/text)
//   - /ready with NO probe wired (in-memory dev) -> 200 {ready:true}
//   - /ready is NOT shadowed by the createCardApp catch-all: a known card 404 still
//     works ALONGSIDE a 200 /ready (the route order in createMarketplaceApp holds).
import { describe, it, expect, vi } from "vitest";
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

// A connection-string-shaped secret the throwing probe leaks into err.message, so the
// value-free assertion proves the catch swallows it and never echoes it.
const FAKE_SECRET = "postgres://secret@host:5432/db";

/** Build the app with an optional storeProbe over empty in-memory stores. */
function makeApp(storeProbe?: () => Promise<void>) {
  const indexStore = new InMemoryIndexStore();
  const cardStore = new InMemoryCardStore();
  const moderationStore = new InMemoryModerationStore();
  const cardSource: CardSource = {
    async getCard(resourceId) {
      return (await cardStore.get(resourceId as Hex)) ?? null;
    },
  };
  const publishPipeline = createPublishPipeline(
    createPublishPipelineDeps({}, { indexStore, cardStore, moderationStore }),
  );
  return createMarketplaceApp({
    indexStore,
    cardStore,
    cardSource,
    publishPipeline,
    storeProbe,
  });
}

describe("marketplace GET /health (constant liveness)", () => {
  it("returns 200 {ok:true,service:'marketplace'} without calling the probe", async () => {
    const probe = vi.fn(async () => {});
    const app = makeApp(probe);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "marketplace" });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("marketplace GET /ready (store-aware readiness)", () => {
  it("returns 200 {ready:true} when the probe resolves", async () => {
    const probe = vi.fn(async () => {});
    const app = makeApp(probe);
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("returns a VALUE-FREE 503 {ready:false} when the probe throws (no secret leaked)", async () => {
    const probe = vi.fn(async () => {
      throw new Error(`connect failed: ${FAKE_SECRET}`);
    });
    const app = makeApp(probe);
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const json = (await res.clone().json()) as Record<string, unknown>;
    expect(json).toEqual({ ready: false });
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain(FAKE_SECRET);
  });

  it("returns 200 {ready:true} when NO probe is wired (in-memory dev)", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it("is NOT shadowed by the card catch-all: a known card 404 still works alongside /ready 200", async () => {
    // /ready is registered BEFORE the createCardApp mount, so the card catch-all never
    // swallows it. Prove both coexist: /ready answers 200 AND an unknown card 404s.
    const app = makeApp(async () => {});
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });

    const card = await app.request(`/${RESOURCE}/.well-known/agent-card.json`);
    expect(card.status).toBe(404);
  });
});
