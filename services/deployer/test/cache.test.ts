// cache.test.ts - the Redis response cache: normalized key + billable disclosed hit (DEP-03).
//
// The money-path-critical invariant (RESEARCH Pitfall 3): a cache HIT skips the
// container BUT is STILL a real, disclosed, billable call. The hit happens AFTER
// `/verify` has reserved the cap, so the billing hook MUST fire on a hit and the
// response MUST disclose `X-Cache: HIT`. A hit skips the HANDLER, never the BILLING.
//
// Under test:
//   1. cacheKey is stable under query/body key reordering + whitespace (canonicalized)
//      and CHANGES when deployVersion changes (redeploy invalidation namespace);
//   2. getOrInvoke MISS -> invokes the handler, stores with the card TTL, no HIT header;
//   3. getOrInvoke HIT -> SKIPS the handler (invoke spy not called), returns the cached
//      body, sets X-Cache: HIT, and FIRES recordBillableCall({cached:true});
//   4. the no-free-bypass invariant: a HIT never returns a body without the billing
//      hook firing (Pitfall 3);
//   5. an in-memory cache backend is the test default (the same getOrInvoke runs
//      against ioredis in prod - same ResponseCache interface).
import { describe, it, expect, vi } from "vitest";
import type { Hex } from "viem";
import { InMemoryResponseCache } from "../src/stores/memory";
import {
  cacheKey,
  getOrInvoke,
  createInMemoryBillingLog,
  type CachedRequest,
} from "../src/cache";

const RESOURCE: Hex = `0x${"c1".repeat(32)}`;

function req(over: Partial<CachedRequest> = {}): CachedRequest {
  return {
    method: "POST",
    path: "/echo",
    query: { b: "2", a: "1" },
    body: '{"text":"hello"}',
    ...over,
  };
}

describe("cache key", () => {
  it("is stable under query/body key reordering + whitespace", () => {
    const k1 = cacheKey(RESOURCE, 1, req({ query: { a: "1", b: "2" }, body: '{"text":"hello"}' }));
    const k2 = cacheKey(RESOURCE, 1, req({ query: { b: "2", a: "1" }, body: '{  "text" : "hello"  }' }));
    expect(k1).toBe(k2);
  });

  it("changes when deployVersion changes (redeploy invalidation namespace)", () => {
    const v1 = cacheKey(RESOURCE, 1, req());
    const v2 = cacheKey(RESOURCE, 2, req());
    expect(v1).not.toBe(v2);
    expect(v1).toContain(":v1:");
    expect(v2).toContain(":v2:");
    expect(v1.startsWith(`resource:${RESOURCE}:`)).toBe(true);
  });

  it("changes when the request differs", () => {
    const a = cacheKey(RESOURCE, 1, req({ body: '{"text":"hello"}' }));
    const b = cacheKey(RESOURCE, 1, req({ body: '{"text":"world"}' }));
    expect(a).not.toBe(b);
  });
});

describe("cache getOrInvoke", () => {
  it("MISS: invokes the handler, stores the body, no X-Cache:HIT", async () => {
    const cache = new InMemoryResponseCache();
    const billing = createInMemoryBillingLog();
    const invoke = vi.fn(async () => '{"echo":"hello"}');

    const res = await getOrInvoke({
      cache,
      resourceId: RESOURCE,
      deployVersion: 1,
      req: req(),
      ttlSeconds: 60,
      invoke,
      recordBillableCall: billing.record,
      idemKey: "nonce-1",
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(res.body).toBe('{"echo":"hello"}');
    expect(res.cached).toBe(false);
    expect(res.headers["X-Cache"]).toBe("MISS");
    // The body was stored under the normalized+versioned key.
    expect(await cache.get(cacheKey(RESOURCE, 1, req()))).toBe('{"echo":"hello"}');
    // A MISS is still a billable call (it invoked the handler).
    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]).toMatchObject({ cached: false, idemKey: "nonce-1" });
  });

  it("HIT: skips the handler, sets X-Cache:HIT, and FIRES the billing hook (disclosed billable call)", async () => {
    const cache = new InMemoryResponseCache();
    const billing = createInMemoryBillingLog();
    // Prime the cache at v1 with the same normalized request.
    await cache.set(cacheKey(RESOURCE, 1, req()), '{"echo":"cached"}', 60);
    const invoke = vi.fn(async () => '{"echo":"fresh"}');

    const res = await getOrInvoke({
      cache,
      resourceId: RESOURCE,
      deployVersion: 1,
      req: req(),
      ttlSeconds: 60,
      invoke,
      recordBillableCall: billing.record,
      idemKey: "nonce-2",
    });

    // Handler SKIPPED.
    expect(invoke).not.toHaveBeenCalled();
    // Cached body returned, disclosed as a hit.
    expect(res.body).toBe('{"echo":"cached"}');
    expect(res.cached).toBe(true);
    expect(res.headers["X-Cache"]).toBe("HIT");
    // The billing hook FIRED with cached:true (the disclosed billable call).
    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]).toMatchObject({
      resourceId: RESOURCE,
      idemKey: "nonce-2",
      cached: true,
    });
  });

  it("no-free-bypass invariant: a HIT NEVER returns a body without firing the billing hook (Pitfall 3)", async () => {
    const cache = new InMemoryResponseCache();
    const billing = createInMemoryBillingLog();
    await cache.set(cacheKey(RESOURCE, 1, req()), '{"echo":"cached"}', 60);

    const res = await getOrInvoke({
      cache,
      resourceId: RESOURCE,
      deployVersion: 1,
      req: req(),
      ttlSeconds: 60,
      invoke: async () => {
        throw new Error("handler must not run on a hit");
      },
      recordBillableCall: billing.record,
      idemKey: "nonce-3",
    });

    // A returned body (200-equivalent) ALWAYS coincides with exactly one billing record.
    expect(res.body).toBeTruthy();
    expect(billing.calls).toHaveLength(1);
  });

  it("uses the in-memory ResponseCache backend (the same getOrInvoke runs against ioredis in prod)", async () => {
    const cache = new InMemoryResponseCache();
    const billing = createInMemoryBillingLog();
    const invoke = vi.fn(async () => "stored");

    // First call MISS stores; second call HIT serves from the same in-memory backend.
    await getOrInvoke({ cache, resourceId: RESOURCE, deployVersion: 5, req: req(), ttlSeconds: 30, invoke, recordBillableCall: billing.record, idemKey: "k1" });
    const second = await getOrInvoke({ cache, resourceId: RESOURCE, deployVersion: 5, req: req(), ttlSeconds: 30, invoke, recordBillableCall: billing.record, idemKey: "k2" });

    expect(invoke).toHaveBeenCalledTimes(1); // only the MISS invoked
    expect(second.cached).toBe(true);
    expect(billing.calls.map((c) => c.cached)).toEqual([false, true]); // both billed
  });
});
