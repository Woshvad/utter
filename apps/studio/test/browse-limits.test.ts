// browse-limits.test.ts - the public browse-loader protections (S9).
//
// Runs in its own file so the shared browse limiter is constructed from THIS file's
// low knob (BROWSE_LIMIT_PER_IP_PER_MIN=1). Every request carries a distinct
// x-forwarded-for except where a same-IP denial is the point. Covers: the per-IP
// 429 on both loaders, the shared 30s TTL memo collapsing the marketplace list
// read across loaders, and the memo expiring on the injected clock.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  resetBrowseStateForTests,
  invalidateListMemo,
} from "../app/limits/browse.server";
import { FIXTURE_CREATOR } from "../app/fixtures/index";

beforeAll(() => {
  process.env.BROWSE_LIMIT_PER_IP_PER_MIN = "1";
});

beforeEach(() => {
  resetBrowseStateForTests();
});

function req(url: string, ip: string): Request {
  return new Request(url, { headers: { "x-forwarded-for": ip } });
}

describe("browse per-IP limiter (S9)", () => {
  it("denies the second discover hit from one IP with a thrown 429 Response", async () => {
    const { loader } = await import("../app/routes/discover");
    const ok = await loader({
      request: req("http://x/discover", "1.1.1.1"),
      params: {},
      context: {},
    } as never);
    expect(ok.cards.length).toBeGreaterThan(0);

    let thrown: unknown;
    try {
      await loader({
        request: req("http://x/discover", "1.1.1.1"),
        params: {},
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("denies the second creator-profile hit from one IP with a thrown 429 Response", async () => {
    const { loader } = await import("../app/routes/creators.$address");
    await loader({
      request: req(`http://x/creators/${FIXTURE_CREATOR}`, "2.2.2.2"),
      params: { address: FIXTURE_CREATOR },
      context: {},
    } as never);

    let thrown: unknown;
    try {
      await loader({
        request: req(`http://x/creators/${FIXTURE_CREATOR}`, "2.2.2.2"),
        params: { address: FIXTURE_CREATOR },
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(429);
  });
});

describe("browse 30s list memo (S9)", () => {
  it("collapses the marketplace list read across loaders and requests", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { listMarketplace: () => unknown },
      "listMarketplace",
    );

    const discover = await import("../app/routes/discover");
    const creators = await import("../app/routes/creators.$address");

    // One discover load performs ONE real list read (the criteria and the
    // categories reads share the {} memo entry).
    await discover.loader({
      request: req("http://x/discover", "3.3.3.1"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);

    // A second discover load (fresh IP) is served from the memo.
    await discover.loader({
      request: req("http://x/discover", "3.3.3.2"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);

    // The creator-profile loader shares the SAME {} memo entry.
    await creators.loader({
      request: req(`http://x/creators/${FIXTURE_CREATOR}`, "3.3.3.3"),
      params: { address: FIXTURE_CREATOR },
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("expires after 30s on the injected clock", async () => {
    let t = 1_000_000;
    resetBrowseStateForTests(() => t);

    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { listMarketplace: () => unknown },
      "listMarketplace",
    );
    const { loader } = await import("../app/routes/discover");

    await loader({
      request: req("http://x/discover", "4.4.4.1"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);

    // Inside the TTL: memo hit.
    t += 29_000;
    await loader({
      request: req("http://x/discover", "4.4.4.2"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);

    // Past the TTL: a real read again.
    t += 2_000;
    await loader({
      request: req("http://x/discover", "4.4.4.3"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("invalidateListMemo forces the next read to hit the source (publish visibility)", async () => {
    resetBrowseStateForTests();
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { listMarketplace: () => unknown },
      "listMarketplace",
    );
    const { loader } = await import("../app/routes/discover");

    await loader({
      request: req("http://x/discover", "5.5.5.1"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);

    // Without invalidation a second read (fresh IP, inside TTL) is a memo hit.
    // Invalidating (the publish path does this) drops the entry so the new listing
    // is read fresh instead of hidden for up to the 30s TTL.
    invalidateListMemo();
    await loader({
      request: req("http://x/discover", "5.5.5.2"),
      params: {},
      context: {},
    } as never);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });
});

describe("browse GLOBAL backstop (S9 - IPv6 rotation)", () => {
  it("denies once the platform-wide window is exhausted even across distinct IPs", async () => {
    // A low global cap so distinct-IP hits (each under the per-IP window) exhaust the
    // global backstop: this is the control that survives source-address rotation.
    process.env.BROWSE_LIMIT_GLOBAL_PER_MIN = "2";
    resetBrowseStateForTests();
    try {
      const { loader } = await import("../app/routes/discover");
      // Two distinct IPs, each its own per-IP bucket, consume the global budget.
      await loader({ request: req("http://x/discover", "6.6.1.1"), params: {}, context: {} } as never);
      await loader({ request: req("http://x/discover", "6.6.1.2"), params: {}, context: {} } as never);

      // A THIRD distinct IP is under its own per-IP limit but the global window is spent.
      let thrown: unknown;
      try {
        await loader({ request: req("http://x/discover", "6.6.1.3"), params: {}, context: {} } as never);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(429);
    } finally {
      delete process.env.BROWSE_LIMIT_GLOBAL_PER_MIN;
      resetBrowseStateForTests();
    }
  });
});
