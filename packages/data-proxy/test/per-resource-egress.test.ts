// per-resource-egress.test.ts: H3 (per-resource allowlist) + M7 (socket-pin).
//
// H3: on a shared multi-tenant proxy the egress allowlist must be a property of
// the VERIFIED resource, not a process-global. These tests prove a host allowed
// for resource B but not A is REJECTED for A (the cross-tenant leak), that the
// global-`allowlist` back-compat form still works, and that the resolver is keyed
// by the token-verified resourceId so a token for A cannot present
// `x-resource-id: B` to borrow B's allowlist (401, before any resolution).
//
// M7: the forward connect is pinned to an already-validated IP. These tests prove
// the pinning-dispatcher factory is invoked with the validated addresses, that the
// dispatcher reaches the forward `fetch`, and that a post-recheck DNS flip to a
// blocked IP does not change the pinned connect target (the pin holds) - while the
// request URL keeps the original hostname so TLS SNI/cert validation is unaffected.
import { describe, it, expect, vi } from "vitest";
import {
  createDataProxy,
  mintResourceToken,
  type AllowlistResolver,
  type DnsLookupAll,
  type PinningDispatcherFactory,
} from "../src/index";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";
const RESOURCE_A = "resource-aaaa-1111"; // -> api.openai.com / sk-real-...AAAA
const RESOURCE_B = "resource-bbbb-2222"; // -> api.weather.example.com / wk-real-...BBBB

/** Every host resolves to one public address (no network). */
function publicDnsStub(): DnsLookupAll {
  return vi.fn(async (_host: string) => [{ address: "93.184.216.34", family: 4 }]);
}

/** An upstream-fetch spy that echoes a 200. */
function upstreamSpy() {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function containerRequest(opts: {
  token?: string;
  resourceId?: string;
  target: string;
}): Request {
  const headers: Record<string, string> = { "x-upstream-url": opts.target };
  if (opts.token) headers["x-resource-token"] = opts.token;
  if (opts.resourceId) headers["x-resource-id"] = opts.resourceId;
  return new Request("http://data-proxy.internal/proxy", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "hello" }),
  });
}

describe("H3 per-resource allowlist", () => {
  // A resolver giving DISTINCT allowlists per resource: A may reach openai, B may
  // reach weather. The two upstreams differ so a cross-tenant borrow is observable.
  const perResourceResolver: AllowlistResolver = (resourceId) => {
    if (resourceId === RESOURCE_A) return ["api.openai.com"];
    if (resourceId === RESOURCE_B) return ["api.weather.example.com"];
    return [];
  };

  it("checks resource A against A's allowlist (its own upstream forwards)", async () => {
    const upstreamFetch = upstreamSpy();
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlistResolver: perResourceResolver,
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("REJECTS a host allowed for B but not A when requested by A (cross-tenant leak closed)", async () => {
    const upstreamFetch = upstreamSpy();
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlistResolver: perResourceResolver,
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    // A presents a host that is on B's allowlist but NOT A's. Under a process-global
    // allowlist this would leak; under per-resource resolution it is default-deny.
    const tokenA = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token: tokenA,
        resourceId: RESOURCE_A,
        target: "https://api.weather.example.com/v1/forecast",
      }),
    );
    expect(res.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("the resolver is keyed by the VERIFIED resourceId: a token for A presenting x-resource-id:B is 401 (cannot borrow B's allowlist)", async () => {
    const upstreamFetch = upstreamSpy();
    const resolverSpy = vi.fn(perResourceResolver);
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlistResolver: resolverSpy,
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    // Token minted for A, but the container claims to be B in the header and asks
    // for B's allowlisted host. The aud!=header mismatch is a hard 401 BEFORE the
    // allowlist resolver is ever consulted - the spoofed header cannot select B's list.
    const tokenA = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token: tokenA,
        resourceId: RESOURCE_B,
        target: "https://api.weather.example.com/v1/forecast",
      }),
    );
    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
    // The resolver was never reached with the spoofed B id (verify short-circuits).
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("back-compat: the single global `allowlist` form still works (wrapped as a resolver for all)", async () => {
    const upstreamFetch = upstreamSpy();
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("default-deny: an unmapped resource resolves to an empty allowlist (no host passes) -> 403", async () => {
    const upstreamFetch = upstreamSpy();
    // Map RESOURCE_B's credential to api.openai.com so the credential resolves, but
    // give B an EMPTY allowlist - the allowlist, not the credential, must deny.
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlistResolver: () => [],
      resolveCredential: () => ({
        upstreamBaseUrl: "https://api.openai.com",
        realApiKey: "irrelevant-server-side-only",
      }),
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("M7 socket-pinning dispatcher", () => {
  it("invokes the pinning factory with the validated addresses and threads the dispatcher to the forward fetch", async () => {
    const upstreamFetch = upstreamSpy();
    const fakeDispatcher = { __pinned: true };
    const factory: PinningDispatcherFactory = vi.fn(async (_host, _addrs) => fakeDispatcher);
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      pinningDispatcherFactory: factory,
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(200);
    // The factory saw the host + the validated public address from the recheck.
    expect(factory).toHaveBeenCalledTimes(1);
    const [pinHost, pinAddrs] = (factory as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]!;
    expect(pinHost).toBe("api.openai.com");
    expect(pinAddrs).toEqual([{ address: "93.184.216.34", family: 4 }]);
    // The dispatcher reached the forward fetch init, AND the URL keeps the original
    // hostname (so TLS SNI/cert validation verifies against api.openai.com, not the IP).
    const [calledUrl, calledInit] = (upstreamFetch.mock.calls[0] ?? []) as [
      string,
      (RequestInit & { dispatcher?: unknown }) | undefined,
    ];
    expect(String(calledUrl)).toContain("api.openai.com");
    expect(String(calledUrl)).not.toContain("93.184.216.34");
    expect(calledInit?.dispatcher).toBe(fakeDispatcher);
  });

  it("the pin holds: a post-recheck DNS flip to a blocked IP does not change the validated address handed to the pin", async () => {
    // DNS returns a PUBLIC address on the first two lookups (the resolve + the
    // recheck both pass), then would flip to a blocked metadata IP on a later
    // lookup. The pin is built from the recheck's validated address, so the connect
    // target is the public IP - the late flip cannot redirect it.
    let calls = 0;
    const flippingDns: DnsLookupAll = vi.fn(async () => {
      calls += 1;
      // 1st (resolve) + 2nd (recheck): public. 3rd+ (a connect-time re-resolve a
      // naive client would do): metadata. The pin never performs that 3rd lookup.
      if (calls <= 2) return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "169.254.169.254", family: 4 }];
    });
    const upstreamFetch = upstreamSpy();
    const capturedAddrs: unknown[] = [];
    const factory: PinningDispatcherFactory = vi.fn(async (_host, addrs) => {
      capturedAddrs.push(...addrs);
      return { __pinned: true };
    });
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: flippingDns,
      pinningDispatcherFactory: factory,
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(200);
    // The pin was built from the VALIDATED public address, never the later blocked IP.
    expect(capturedAddrs).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(capturedAddrs).not.toContainEqual({ address: "169.254.169.254", family: 4 });
  });

  it("no-pin fallback: a factory returning undefined leaves the forward init free of `dispatcher` (today's behavior, unchanged)", async () => {
    const upstreamFetch = upstreamSpy();
    const factory: PinningDispatcherFactory = vi.fn(async () => undefined);
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      pinningDispatcherFactory: factory,
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(200);
    const [, calledInit] = (upstreamFetch.mock.calls[0] ?? []) as [
      string,
      (RequestInit & { dispatcher?: unknown }) | undefined,
    ];
    expect(calledInit && "dispatcher" in calledInit).toBe(false);
  });

  it("a blocked resolved IP still 403s BEFORE the pin is built (pinning is additive, not a bypass)", async () => {
    const rebind: DnsLookupAll = vi.fn(async () => [
      { address: "169.254.169.254", family: 4 },
    ]);
    const upstreamFetch = upstreamSpy();
    const factory: PinningDispatcherFactory = vi.fn(async () => ({ __pinned: true }));
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: rebind,
      pinningDispatcherFactory: factory,
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
