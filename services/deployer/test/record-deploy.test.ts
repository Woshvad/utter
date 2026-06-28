// record-deploy.test.ts - persisting a durable DeploymentRecord on a successful deploy.
//
// recordDeployment writes the desired-state record the reconcile loop converges on:
//   1. a first call creates a v1 record (status running; agentId is the resourceId
//      placeholder until the deferred ERC-8004 mint lands; slug carried);
//   2. a second call for the SAME resourceId is an idempotent redeploy - deployVersion
//      bumps 1 -> 2 while agentId + slug are preserved (DEP-04);
//   3. a DIFFERENT resourceId reusing a claimed slug throws SlugConflictError (M5);
//   4. an optional cap is carried on the first write and preserved across a redeploy.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { InMemoryDeploymentStore, SlugConflictError } from "../src/stores/memory";
import { recordDeployment } from "../src/record-deploy";

const RESOURCE: Hex = `0x${"d4".repeat(32)}`;
const OTHER_RESOURCE: Hex = `0x${"e7".repeat(32)}`;

describe("recordDeployment", () => {
  it("creates a v1 running record with the resourceId placeholder agentId and the slug", async () => {
    const store = new InMemoryDeploymentStore();

    const record = await recordDeployment(store, {
      resourceId: RESOURCE,
      slug: "weather-bot",
      now: () => 1_000,
    });

    expect(record.deployVersion).toBe(1);
    expect(record.status).toBe("running");
    expect(record.slug).toBe("weather-bot");
    // The deferred-mint placeholder: agentId === resourceId.
    expect(record.agentId).toBe(RESOURCE);
    expect(record.resourceId).toBe(RESOURCE);
    expect(record.updatedAt).toBe(1_000);

    // It was persisted (so GET /deployments will surface it).
    const stored = await store.get(RESOURCE);
    expect(stored).not.toBeNull();
    expect(stored?.deployVersion).toBe(1);
  });

  it("bumps deployVersion to 2 on a second deploy of the same resourceId and preserves agentId + slug", async () => {
    const store = new InMemoryDeploymentStore();

    const first = await recordDeployment(store, {
      resourceId: RESOURCE,
      slug: "weather-bot",
      now: () => 1_000,
    });
    const second = await recordDeployment(store, {
      resourceId: RESOURCE,
      slug: "weather-bot",
      now: () => 2_000,
    });

    expect(second.deployVersion).toBe(2);
    expect(second.status).toBe("running");
    // Identity preserved across the redeploy (DEP-04).
    expect(second.agentId).toBe(first.agentId);
    expect(second.slug).toBe("weather-bot");
    expect(second.updatedAt).toBe(2_000);

    const stored = await store.get(RESOURCE);
    expect(stored?.deployVersion).toBe(2);
    expect(stored?.agentId).toBe(first.agentId);
    expect(stored?.slug).toBe("weather-bot");
  });

  it("throws SlugConflictError when a different resourceId reuses a claimed slug (M5)", async () => {
    const store = new InMemoryDeploymentStore();
    await recordDeployment(store, { resourceId: RESOURCE, slug: "weather-bot" });

    await expect(
      recordDeployment(store, { resourceId: OTHER_RESOURCE, slug: "weather-bot" }),
    ).rejects.toBeInstanceOf(SlugConflictError);

    // The original owner's record is unchanged.
    const stored = await store.get(RESOURCE);
    expect(stored?.resourceId).toBe(RESOURCE);
  });

  it("carries the cap on the first write and preserves it across a redeploy", async () => {
    const store = new InMemoryDeploymentStore();

    const first = await recordDeployment(store, {
      resourceId: RESOURCE,
      slug: "weather-bot",
      cap: 50_000n,
    });
    expect(first.cap).toBe(50_000n);

    // A redeploy with no cap carries the existing cap forward.
    const second = await recordDeployment(store, {
      resourceId: RESOURCE,
      slug: "weather-bot",
    });
    expect(second.deployVersion).toBe(2);
    expect(second.cap).toBe(50_000n);
  });
});
