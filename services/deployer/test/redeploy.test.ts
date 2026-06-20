// redeploy.test.ts - redeploy semantics (DEP-04).
//
// A redeploy is an IDENTITY-PRESERVING version bump:
//   1. agentId + slug (and thus the `<slug>.resources.<domain>` URL) PERSIST across
//      the redeploy - the resource keeps its on-chain identity + public address;
//   2. deployVersion bumps n -> n+1, which RE-NAMESPACES the cache (DEP-03 keys are
//      `...:v<deployVersion>:...`), so every old-version key is instantly unreachable
//      = atomic cache invalidation (T-03-21);
//   3. a price change applies ONLY to NEW calls - the new version's quote carries the
//      new pricing; previously-cached old-version results are simply unreachable, never
//      retro-repriced (T-03-22).
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import {
  InMemoryDeploymentStore,
  InMemoryResponseCache,
  type DeploymentRecord,
} from "../src/stores/memory";
import { redeploy } from "../src/redeploy";
import { cacheKey, type CachedRequest } from "../src/cache";

const AGENT: Hex = `0x${"a9".repeat(32)}`;
const RESOURCE: Hex = `0x${"d4".repeat(32)}`;

function seed(over: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    agentId: AGENT,
    resourceId: RESOURCE,
    slug: "weather-bot",
    deployVersion: 1,
    status: "running",
    updatedAt: 1_000,
    ...over,
  };
}

function req(): CachedRequest {
  return { method: "POST", path: "/echo", body: '{"text":"hi"}' };
}

describe("redeploy", () => {
  it("preserves agentId + slug/URL and bumps deployVersion (1 -> 2)", async () => {
    const store = new InMemoryDeploymentStore();
    await store.put(seed());

    const next = await redeploy({ store, resourceId: RESOURCE });

    expect(next.agentId).toBe(AGENT);
    expect(next.slug).toBe("weather-bot");
    expect(next.deployVersion).toBe(2);
    // The persisted record was updated in place.
    const stored = await store.get(RESOURCE);
    expect(stored?.deployVersion).toBe(2);
    expect(stored?.slug).toBe("weather-bot");
    expect(stored?.agentId).toBe(AGENT);
  });

  it("invalidates the cache atomically: old-version keys are unreachable after the bump", async () => {
    const store = new InMemoryDeploymentStore();
    await store.put(seed({ deployVersion: 1 }));
    const cache = new InMemoryResponseCache();
    // A cached result at v1.
    const oldKey = cacheKey(RESOURCE, 1, req());
    await cache.set(oldKey, '{"echo":"old"}', 600);

    const next = await redeploy({ store, resourceId: RESOURCE, cache });

    // The new version's key is a MISS (the namespace changed = atomic invalidation).
    const newKey = cacheKey(RESOURCE, next.deployVersion, req());
    expect(newKey).not.toBe(oldKey);
    expect(await cache.get(newKey)).toBeNull();
    // The eager DEL removed the old-version entry too (no stale bytes left behind).
    expect(await cache.get(oldKey)).toBeNull();
  });

  it("applies a price change ONLY to new calls (the new version carries the new pricing)", async () => {
    const store = new InMemoryDeploymentStore();
    await store.put(seed({ deployVersion: 3 }));

    const next = await redeploy({
      store,
      resourceId: RESOURCE,
      config: { cap: 50_000n },
    });

    expect(next.deployVersion).toBe(4);
    expect(next.cap).toBe(50_000n);
    // Identity is still preserved alongside the new pricing.
    expect(next.agentId).toBe(AGENT);
    expect(next.slug).toBe("weather-bot");
  });

  it("throws when the resource was never deployed (nothing to redeploy)", async () => {
    const store = new InMemoryDeploymentStore();
    await expect(redeploy({ store, resourceId: RESOURCE })).rejects.toThrow();
  });
});
