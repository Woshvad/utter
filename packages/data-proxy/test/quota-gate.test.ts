// Quota gate wiring tests (PRX-03). The /proxy path enforces a per-resource quota
// counter AFTER token-verify + allowlist and BEFORE inject+forward. Over the budget
// it returns 429 fail-CLOSED (no upstream forward). Under the budget the existing
// egress path is untouched (the forward still happens with the real key injected).
// The counter is plain call/byte accounting - never a USDC amount, no decimals
// literal - and the markup is attributable to the platform cut, not a double-charge.
import { describe, it, expect, vi } from "vitest";
import {
  createDataProxy,
  mintResourceToken,
  InMemoryQuotaStore,
  quotaGate,
  type DnsLookupAll,
  type QuotaBudget,
  type QuotaStore,
} from "../src/index";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";
const RESOURCE_A = "resource-aaaa-1111"; // -> api.openai.com / sk-real-...AAAA
const REAL_KEY_A = "sk-real-upstream-key-AAAA-server-side-only";

function publicDnsStub(): DnsLookupAll {
  return vi.fn(async (_host: string) => [{ address: "93.184.216.34", family: 4 }]);
}

/** Build a quota-wired proxy with an injected upstream-fetch spy that echoes a 200. */
function makeProxy(over: { quotaBudget?: QuotaBudget } = {}) {
  const upstreamFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true, upstream: "hit" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const quotaStore = new InMemoryQuotaStore();
  const app = createDataProxy({
    tokenSecret: SECRET,
    allowlist: ["api.openai.com"],
    upstreamFetch: upstreamFetch as unknown as typeof fetch,
    dnsLookup: publicDnsStub(),
    quotaStore,
    quotaBudget: over.quotaBudget ?? { calls: 2, bytes: 1_000_000 },
  });
  return { app, upstreamFetch, quotaStore };
}

function containerRequest(target: string): Request {
  const token = mintResourceToken(RESOURCE_A, 120, SECRET);
  return new Request("http://data-proxy.internal/proxy", {
    method: "POST",
    headers: {
      "x-upstream-url": target,
      "x-resource-token": token,
      "x-resource-id": RESOURCE_A,
    },
    body: JSON.stringify({ prompt: "hello" }),
  });
}

const TARGET = "https://api.openai.com/v1/chat/completions";

describe("data-proxy quota gate (PRX-03)", () => {
  it("forwards while under the call budget", async () => {
    const { app, upstreamFetch } = makeProxy({ quotaBudget: { calls: 2, bytes: 1_000_000 } });
    const res = await app.request(containerRequest(TARGET));
    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 429 fail-closed once the call budget is exceeded (no forward)", async () => {
    const { app, upstreamFetch } = makeProxy({ quotaBudget: { calls: 1, bytes: 1_000_000 } });
    const ok = await app.request(containerRequest(TARGET));
    expect(ok.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    const blocked = await app.request(containerRequest(TARGET));
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error?: string };
    expect(body.error).toBe("quota_exceeded");
    // FAIL-CLOSED: the over-quota call never reached the upstream.
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 429 fail-closed once the byte budget is exceeded", async () => {
    const { app, upstreamFetch } = makeProxy({ quotaBudget: { calls: 1000, bytes: 1 } });
    const blocked = await app.request(containerRequest(TARGET));
    expect(blocked.status).toBe(429);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("keeps independent budgets per resource (counter is per-resource)", async () => {
    const { app, quotaStore } = makeProxy({ quotaBudget: { calls: 1, bytes: 1_000_000 } });
    await app.request(containerRequest(TARGET));
    const totals = await quotaStore.increment(RESOURCE_A, { calls: 0, bytes: 0 });
    expect(totals.calls).toBe(1);
  });

  it("still injects the real key on the forwarded (under-budget) leg - egress untouched", async () => {
    const { app, upstreamFetch } = makeProxy({ quotaBudget: { calls: 5, bytes: 1_000_000 } });
    await app.request(containerRequest(TARGET));
    const [, calledInit] = upstreamFetch.mock.calls[0]!;
    const outHeaders = new Headers((calledInit as RequestInit | undefined)?.headers);
    expect(outHeaders.get("authorization")).toBe(`Bearer ${REAL_KEY_A}`);
  });

  it("rejects an unauthlisted host with 403 BEFORE counting quota (order preserved)", async () => {
    const { app, quotaStore } = makeProxy({ quotaBudget: { calls: 1, bytes: 1_000_000 } });
    const res = await app.request(containerRequest("https://evil.example.com/v1"));
    expect(res.status).toBe(403);
    // The blocked request must not consume the resource's quota (counted only after allowlist).
    const totals = await quotaStore.increment(RESOURCE_A, { calls: 0, bytes: 0 });
    expect(totals.calls).toBe(0);
  });

  it("rejects an invalid token with 401 BEFORE counting quota", async () => {
    const { app, quotaStore } = makeProxy({ quotaBudget: { calls: 1, bytes: 1_000_000 } });
    const bad = new Request("http://data-proxy.internal/proxy", {
      method: "POST",
      headers: {
        "x-upstream-url": TARGET,
        "x-resource-token": "not-a-valid-token",
        "x-resource-id": RESOURCE_A,
      },
      body: "{}",
    });
    const res = await app.request(bad);
    expect(res.status).toBe(401);
    const totals = await quotaStore.increment(RESOURCE_A, { calls: 0, bytes: 0 });
    expect(totals.calls).toBe(0);
  });

  it("WR-03: denies with 429 (fail-closed) when the counter store throws on increment (no forward)", async () => {
    const upstreamFetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    // A quota store whose increment always throws (e.g. Redis unreachable).
    const throwingStore: QuotaStore = {
      async increment() {
        throw new Error("quota store unreachable (simulated)");
      },
    };
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      quotaStore: throwingStore,
      quotaBudget: { calls: 100, bytes: 1_000_000 },
    });

    const res = await app.request(containerRequest(TARGET));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("quota_unavailable");
    // EXPLICIT fail-closed: a counter-store error never forwards upstream.
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("IN-02: meters the upstream RESPONSE bytes into the per-resource counter", async () => {
    const responsePayload = JSON.stringify({ ok: true, upstream: "hit" });
    const upstreamFetch = vi.fn(
      async () =>
        new Response(responsePayload, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const quotaStore = new InMemoryQuotaStore();
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      quotaStore,
      quotaBudget: { calls: 100, bytes: 10_000_000 },
    });

    const inboundBytes = new TextEncoder().encode(JSON.stringify({ prompt: "hello" })).byteLength;
    const responseBytes = new TextEncoder().encode(responsePayload).byteLength;

    const res = await app.request(containerRequest(TARGET));
    expect(res.status).toBe(200);

    // The counter reflects BOTH the inbound request bytes AND the relayed response bytes.
    const totals = await quotaStore.increment(RESOURCE_A, { calls: 0, bytes: 0 });
    expect(totals.calls).toBe(1);
    expect(totals.bytes).toBe(inboundBytes + responseBytes);
  });

  it("is unbounded (no gate) when no quotaBudget is configured - egress unchanged", async () => {
    const upstreamFetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      // no quotaStore / quotaBudget
    });
    for (let i = 0; i < 5; i++) await app.request(containerRequest(TARGET));
    expect(upstreamFetch).toHaveBeenCalledTimes(5);
  });
});

// quotaGate (SCL-05): the deny-on-exhaustion ceiling check as a reusable gate over the
// EXISTING QuotaStore seam (the same store the proxy uses). It increments via the store
// and returns "deny" once the running total crosses the configured ceiling - the unit
// core the spend-cap plan exports alongside spendCapGate. Counters stay PLAIN NUMBERS
// (call/byte accounting) and are NEVER summed with the spend-cap bigint money.
describe("quotaGate deny-on-exhaustion (ceiling over the existing QuotaStore seam)", () => {
  const RES = "resource-quota-gate-1";

  it("allows within the ceiling and denies once a counter crosses it", async () => {
    const store = new InMemoryQuotaStore();
    const ceiling: QuotaBudget = { calls: 2, bytes: 1_000_000 };
    expect(await quotaGate(RES, { calls: 1, bytes: 10 }, ceiling, store)).toBe("allow");
    expect(await quotaGate(RES, { calls: 1, bytes: 10 }, ceiling, store)).toBe("allow");
    // The third call pushes calls to 3 > ceiling.calls=2 -> deny.
    expect(await quotaGate(RES, { calls: 1, bytes: 10 }, ceiling, store)).toBe("deny");
  });

  it("denies when EITHER the call OR the byte ceiling is exceeded", async () => {
    const store = new InMemoryQuotaStore();
    // A single big-byte request blows the byte ceiling immediately.
    const ceiling: QuotaBudget = { calls: 1000, bytes: 100 };
    expect(await quotaGate(RES, { calls: 1, bytes: 101 }, ceiling, store)).toBe("deny");
  });

  it("keeps per-resource counters independent (reuses the existing per-resource store)", async () => {
    const store = new InMemoryQuotaStore();
    const ceiling: QuotaBudget = { calls: 1, bytes: 1_000_000 };
    expect(await quotaGate("res-x", { calls: 1, bytes: 5 }, ceiling, store)).toBe("allow");
    // res-x is now at its ceiling; res-y still has room (counters are per-resource).
    expect(await quotaGate("res-x", { calls: 1, bytes: 5 }, ceiling, store)).toBe("deny");
    expect(await quotaGate("res-y", { calls: 1, bytes: 5 }, ceiling, store)).toBe("allow");
  });

  it("counters stay plain numbers (never bigint money) - the value the store returns is a number", async () => {
    const store = new InMemoryQuotaStore();
    const ceiling: QuotaBudget = { calls: 5, bytes: 5_000 };
    await quotaGate(RES, { calls: 1, bytes: 100 }, ceiling, store);
    const totals = await store.increment(RES, { calls: 0, bytes: 0 });
    expect(typeof totals.calls).toBe("number");
    expect(typeof totals.bytes).toBe("number");
  });
});
