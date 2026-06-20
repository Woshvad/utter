// Hono data-proxy passthrough (PRX-01, PRX-02).
//
// The load-bearing invariant: the CONTAINER-visible inbound request carries ONLY
// the short-lived scoped token, NEVER a real upstream key. The proxy verifies the
// token, enforces the allowlist (SSRF-normalized), resolves the real credential
// server-side, and injects it ONLY on the proxy->upstream leg. The upstream-fetch
// spy lets us assert exactly which leg the real key appears on, and that 401/403
// reject BEFORE any forward.
import { describe, it, expect, vi } from "vitest";
import { createDataProxy, mintResourceToken, type DnsLookupAll } from "../src/index";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";
const RESOURCE_A = "resource-aaaa-1111"; // -> api.openai.com / sk-real-...AAAA
const REAL_KEY_A = "sk-real-upstream-key-AAAA-server-side-only";

/**
 * A deterministic DNS stub so tests never hit the network. By default every host
 * resolves to a public address; individual tests override it to simulate a
 * rebinding record (an allowlisted host resolving to a private/metadata IP).
 */
function publicDnsStub(): DnsLookupAll {
  return vi.fn(async (_host: string) => [{ address: "93.184.216.34", family: 4 }]);
}

/** Build a proxy with an injected upstream-fetch spy that echoes a 200. */
function makeProxy(over: { dnsLookup?: DnsLookupAll } = {}) {
  const upstreamFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true, upstream: "hit" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const app = createDataProxy({
    tokenSecret: SECRET,
    allowlist: ["api.openai.com"],
    upstreamFetch: upstreamFetch as unknown as typeof fetch,
    dnsLookup: over.dnsLookup ?? publicDnsStub(),
  });
  return { app, upstreamFetch };
}

/**
 * Issue an inbound (container-side) proxy request. The container presents the
 * scoped token + the requested upstream URL; it does NOT (and cannot) present a
 * real upstream key.
 */
function containerRequest(opts: {
  token?: string;
  resourceId?: string;
  target: string;
}): Request {
  const headers: Record<string, string> = {
    "x-upstream-url": opts.target,
  };
  if (opts.token) headers["x-resource-token"] = opts.token;
  if (opts.resourceId) headers["x-resource-id"] = opts.resourceId;
  return new Request("http://data-proxy.internal/proxy", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "hello" }),
  });
}

describe("createDataProxy passthrough", () => {
  it("forwards a valid-token request to an allowlisted upstream", async () => {
    const { app, upstreamFetch } = makeProxy();
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
    const body = (await res.json()) as { upstream?: string };
    expect(body.upstream).toBe("hit");
  });

  it("injects the REAL upstream key on the proxy->upstream leg", async () => {
    const { app, upstreamFetch } = makeProxy();
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    const [calledUrl, calledInit] = upstreamFetch.mock.calls[0]!;
    // Forwarded to the resolved upstream base + the container's path.
    expect(String(calledUrl)).toContain("api.openai.com");
    const outHeaders = new Headers((calledInit as RequestInit | undefined)?.headers);
    expect(outHeaders.get("authorization")).toBe(`Bearer ${REAL_KEY_A}`);
  });

  it("KEY-NEVER-LEAKS: the container request carries only the token, never the real key", async () => {
    const { app, upstreamFetch } = makeProxy();
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const inbound = containerRequest({
      token,
      resourceId: RESOURCE_A,
      target: "https://api.openai.com/v1/chat/completions",
    });
    // The inbound (container-visible) request must NOT contain the real key anywhere.
    const inboundHeaderDump = JSON.stringify([...inbound.headers.entries()]);
    expect(inboundHeaderDump).not.toContain(REAL_KEY_A);
    expect(inbound.headers.get("authorization")).toBeNull();
    expect(inbound.headers.get("x-resource-token")).toBe(token);

    await app.request(inbound.clone());

    // The real key appears ONLY on the outbound proxy->upstream leg.
    const [, calledInit] = upstreamFetch.mock.calls[0]!;
    const outHeaders = new Headers((calledInit as RequestInit | undefined)?.headers);
    expect(outHeaders.get("authorization")).toBe(`Bearer ${REAL_KEY_A}`);
    // And the token (container-scoped) is NOT forwarded upstream.
    expect(outHeaders.get("x-resource-token")).toBeNull();
  });

  it("rejects an invalid/garbage token 401 with no forward", async () => {
    const { app, upstreamFetch } = makeProxy();
    const res = await app.request(
      containerRequest({
        token: "not.a.valid.jwt",
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects a missing token 401 with no forward", async () => {
    const { app, upstreamFetch } = makeProxy();
    const res = await app.request(
      containerRequest({
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects a wrong-audience token 401 (token minted for another resource)", async () => {
    const { app, upstreamFetch } = makeProxy();
    const tokenForB = mintResourceToken("resource-bbbb-2222", 120, SECRET);
    const res = await app.request(
      containerRequest({
        token: tokenForB,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects an expired token 401 with no forward", async () => {
    const { app, upstreamFetch } = makeProxy();
    const expired = mintResourceToken(RESOURCE_A, -10, SECRET);
    const res = await app.request(
      containerRequest({
        token: expired,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted host 403 with no forward and no cred resolution", async () => {
    const { app, upstreamFetch } = makeProxy();
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://evil.example.com/steal",
      }),
    );
    expect(res.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects an SSRF metadata target 403 even with a valid token", async () => {
    const { app, upstreamFetch } = makeProxy();
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "http://169.254.169.254/latest/meta-data/",
      }),
    );
    expect(res.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("verify happens BEFORE the allowlist: a bad token to a bad host is 401 (token checked first)", async () => {
    const { app, upstreamFetch } = makeProxy();
    const res = await app.request(
      containerRequest({
        token: "garbage",
        resourceId: RESOURCE_A,
        target: "http://169.254.169.254/",
      }),
    );
    // The order is verify -> allowlist; a bad token short-circuits at 401.
    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("createDataProxy SSRF host-pinning (CR-01)", () => {
  it("REJECTS a request whose allowlisted target host differs from the credential host (no host swap, no forward)", async () => {
    // The container presents a DIFFERENT allowlisted host than its resource's
    // credential maps to. Forwarding it under the real key would let the container
    // drive an arbitrary host/path under another resource's upstream key. Reject.
    const { app, upstreamFetch } = makeProxy();
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const app2 = createDataProxy({
      tokenSecret: SECRET,
      // RESOURCE_A maps to api.openai.com; allow a second host so it passes the
      // allowlist string check but mismatches the credential host.
      allowlist: ["api.openai.com", "api.weather.example.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const res = await app2.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.weather.example.com/v1/forecast",
      }),
    );
    void app; // keep the default proxy fixture referenced
    expect(res.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("the real upstream key NEVER appears in the response or its headers returned to the caller", async () => {
    const { app } = makeProxy();
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(200);
    const headerDump = JSON.stringify([...res.headers.entries()]);
    expect(headerDump).not.toContain(REAL_KEY_A);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(REAL_KEY_A);
  });
});

describe("createDataProxy resolved-IP SSRF guard (CR-02, DNS rebinding)", () => {
  it("REJECTS an allowlisted host that resolves to the cloud metadata IP 169.254.169.254", async () => {
    const rebind: DnsLookupAll = vi.fn(async () => [
      { address: "169.254.169.254", family: 4 },
    ]);
    const { app, upstreamFetch } = makeProxy({ dnsLookup: rebind });
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

  it("REJECTS an allowlisted host that resolves to RFC1918 (10.x) — no forward under the real key", async () => {
    const rebind: DnsLookupAll = vi.fn(async () => [{ address: "10.1.2.3", family: 4 }]);
    const { app, upstreamFetch } = makeProxy({ dnsLookup: rebind });
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

  it("REJECTS an allowlisted host that resolves to loopback 127.0.0.1", async () => {
    const rebind: DnsLookupAll = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const { app, upstreamFetch } = makeProxy({ dnsLookup: rebind });
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

  it("REJECTS when ANY of several resolved addresses is blocked (one public + one metadata)", async () => {
    const rebind: DnsLookupAll = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const { app, upstreamFetch } = makeProxy({ dnsLookup: rebind });
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

  it("FORWARDS when the allowlisted host resolves to a public address (the legitimate path still works)", async () => {
    const { app, upstreamFetch } = makeProxy();
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
});

describe("createDataProxy size caps + timeout (WR-01)", () => {
  it("REJECTS an oversize request body with 413 before forwarding", async () => {
    const { app, upstreamFetch } = makeProxy();
    const proxy = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      maxRequestBytes: 16,
    });
    void app;
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const big = new Request("http://data-proxy.internal/proxy", {
      method: "POST",
      headers: {
        "x-resource-token": token,
        "x-resource-id": RESOURCE_A,
        "x-upstream-url": "https://api.openai.com/v1/chat/completions",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "x".repeat(1024) }),
    });
    const res = await proxy.request(big);
    expect(res.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("REJECTS an oversize upstream response with 502 before relaying", async () => {
    const fatUpstream = vi.fn(async () =>
      new Response("y".repeat(4096), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const proxy = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: fatUpstream as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
      maxResponseBytes: 64,
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await proxy.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(502);
  });

  it("returns 504 when the upstream aborts on the egress timeout", async () => {
    const hang: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;
    const proxy = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: hang,
      dnsLookup: publicDnsStub(),
      egressTimeoutSeconds: 0.01,
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await proxy.request(
      containerRequest({
        token,
        resourceId: RESOURCE_A,
        target: "https://api.openai.com/v1/chat/completions",
      }),
    );
    expect(res.status).toBe(504);
  });
});
