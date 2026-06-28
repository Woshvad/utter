// ready-route suite (Provisioning track, subtask 4): GET /health (a constant liveness
// check) + GET /ready (the store-aware readiness probe) on the deployer control plane.
//
// Fully offline + in-process: createDeployerApp driven through app.request. No docker /
// chain / host is exercised. The probe lives on deps.stores.probe:
//   - /health -> 200 {ok:true,service:'deployer'} (constant; never calls the probe)
//   - /ready over the in-memory stores (resolving no-op probe) -> 200 {ready:true}
//   - /ready with an INJECTED throwing probe (message carries a fake secret) -> 503
//     {ready:false}, VALUE-FREE (no 'secret' / 'postgres://' in the body/text)
//   - /ready with NO probe wired -> 200 {ready:true}
import { describe, it, expect, vi } from "vitest";
import { createDeployerApp } from "../src/server";
import { createInMemoryStores } from "../src/stores/memory";
import type { DeployerStores } from "../src/stores/memory";

// A connection-string-shaped secret the throwing probe leaks into err.message, so the
// value-free assertion proves the catch swallows it and never echoes it.
const FAKE_SECRET = "postgres://secret@host:6379/0";

/** Build the deployer app over a given stores bundle. */
function makeApp(stores: DeployerStores) {
  return createDeployerApp({ stores });
}

describe("deployer GET /health (constant liveness)", () => {
  it("returns 200 {ok:true,service:'deployer'} (constant, store-free)", async () => {
    const app = makeApp(createInMemoryStores());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "deployer" });
  });
});

describe("deployer GET /ready (store-aware readiness)", () => {
  it("returns 200 {ready:true} over the in-memory stores (resolving probe)", async () => {
    const app = makeApp(createInMemoryStores());
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it("returns a VALUE-FREE 503 {ready:false} when the probe throws (no secret leaked)", async () => {
    const stores = createInMemoryStores();
    const probe = vi.fn(async () => {
      throw new Error(`PING failed: ${FAKE_SECRET}`);
    });
    const app = makeApp({ ...stores, probe });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const json = (await res.clone().json()) as Record<string, unknown>;
    expect(json).toEqual({ ready: false });
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain(FAKE_SECRET);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("returns 200 {ready:true} when NO probe is wired", async () => {
    const stores = createInMemoryStores();
    // Drop the probe to simulate an adapter that wires none.
    const app = makeApp({ ...stores, probe: undefined });
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });
});
