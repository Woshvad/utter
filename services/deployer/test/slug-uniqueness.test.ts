// slug-uniqueness.test.ts - the M5 global slug-uniqueness store invariant.
//
// Two resourceIds claiming one slug derive the SAME utter_pairnet_<slug> internal
// bridge and co-tenant a single network, re-opening the cross-tenant free-compute HIGH
// (infrastructure/RESOURCE-DEPLOY-SECURITY-REVIEW.md:81-89). The DeploymentStore is the
// upstream slug allocator: put() must reject a duplicate slug from a different resourceId
// BEFORE any pairnet/Traefik write, while staying idempotent for a same-resourceId
// redeploy (DEP-04). These tests assert BEHAVIOR, not the index internals.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import {
  InMemoryDeploymentStore,
  SlugConflictError,
  type DeploymentRecord,
} from "../src/stores/memory";

const AGENT_A: Hex = `0x${"a9".repeat(32)}`;
const AGENT_B: Hex = `0x${"b7".repeat(32)}`;
const RESOURCE_A: Hex = `0x${"d4".repeat(32)}`;
const RESOURCE_B: Hex = `0x${"e6".repeat(32)}`;

function seed(over: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    agentId: AGENT_A,
    resourceId: RESOURCE_A,
    slug: "weather-bot",
    deployVersion: 1,
    status: "running",
    updatedAt: 1_000,
    ...over,
  };
}

describe("slug uniqueness (M5)", () => {
  it("rejects a different resourceId claiming an already-held slug", async () => {
    const store = new InMemoryDeploymentStore();
    await store.put(seed({ resourceId: RESOURCE_A, agentId: AGENT_A, slug: "shared" }));

    const conflicting = seed({ resourceId: RESOURCE_B, agentId: AGENT_B, slug: "shared" });
    await expect(store.put(conflicting)).rejects.toThrow(SlugConflictError);

    // The message names the slug AND both resourceIds (the operator's debuggable signal).
    let captured: unknown;
    try {
      await store.put(conflicting);
    } catch (err) {
      captured = err;
    }
    expect(captured instanceof SlugConflictError).toBe(true);
    const message = (captured as Error).message;
    expect(message).toContain("shared");
    expect(message).toContain(RESOURCE_A);
    expect(message).toContain(RESOURCE_B);
  });

  it("stays idempotent for a same-resourceId redeploy (bumped deployVersion, no throw)", async () => {
    const store = new InMemoryDeploymentStore();
    await store.put(seed({ deployVersion: 1 }));

    // A redeploy keeps the same resourceId + slug and bumps the version; it must not throw.
    await expect(
      store.put(seed({ deployVersion: 2 })),
    ).resolves.toBeUndefined();

    const stored = await store.get(RESOURCE_A);
    expect(stored?.deployVersion).toBe(2);
    expect(stored?.slug).toBe("weather-bot");
  });

  it("getBySlug returns the owning record for a claimed slug and null for an unclaimed one", async () => {
    const store = new InMemoryDeploymentStore();
    const record = seed({ slug: "claimed" });
    await store.put(record);

    expect(await store.getBySlug("claimed")).toEqual(record);
    expect(await store.getBySlug("never-claimed")).toBeNull();
  });

  it("frees an old slug on an own-slug change so a different resourceId may claim it", async () => {
    const store = new InMemoryDeploymentStore();
    // A claims "old", then A changes its own slug to "new".
    await store.put(seed({ resourceId: RESOURCE_A, agentId: AGENT_A, slug: "old" }));
    await store.put(seed({ resourceId: RESOURCE_A, agentId: AGENT_A, slug: "new" }));

    // A DIFFERENT resourceId B can now claim the freed "old" slug with no conflict.
    const bUnderOld = seed({ resourceId: RESOURCE_B, agentId: AGENT_B, slug: "old" });
    await expect(store.put(bUnderOld)).resolves.toBeUndefined();
    expect(await store.getBySlug("old")).toEqual(bUnderOld);
  });

  it("leaves the original owner untouched after a conflict throw (resolvable by get and getBySlug)", async () => {
    const store = new InMemoryDeploymentStore();
    const owner = seed({ resourceId: RESOURCE_A, agentId: AGENT_A, slug: "defended" });
    await store.put(owner);

    await expect(
      store.put(seed({ resourceId: RESOURCE_B, agentId: AGENT_B, slug: "defended" })),
    ).rejects.toThrow(SlugConflictError);

    // Defense-in-depth: the conflict path mutated nothing; the original owner is intact.
    expect(await store.get(RESOURCE_A)).toEqual(owner);
    expect(await store.getBySlug("defended")).toEqual(owner);
    // The losing resourceId never got a record.
    expect(await store.get(RESOURCE_B)).toBeNull();
  });
});
