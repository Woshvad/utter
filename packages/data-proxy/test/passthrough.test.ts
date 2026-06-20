// Hono data-proxy passthrough (PRX-01, PRX-02).
//
// The load-bearing invariant: the CONTAINER-visible inbound request carries ONLY
// the short-lived scoped token, NEVER a real upstream key. The proxy verifies the
// token, enforces the allowlist (SSRF-normalized), resolves the real credential
// server-side, and injects it ONLY on the proxy->upstream leg. The upstream-fetch
// spy lets us assert exactly which leg the real key appears on, and that 401/403
// reject BEFORE any forward.
import { describe, it, expect, vi } from "vitest";
import { createDataProxy, mintResourceToken } from "../src/index";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";
const RESOURCE_A = "resource-aaaa-1111"; // -> api.openai.com / sk-real-...AAAA
const REAL_KEY_A = "sk-real-upstream-key-AAAA-server-side-only";

/** Build a proxy with an injected upstream-fetch spy that echoes a 200. */
function makeProxy() {
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
