// redirect-ssrf.test.ts: H1 (no redirect-following SSRF).
//
// A 3xx from an allowlisted upstream must NOT be auto-followed. Auto-following
// would re-fetch the Location target with fresh DNS, bypassing every first-hop
// guard (allowlist, block-set, host-equality, resolve-and-recheck, the M7 socket
// pin) and carrying the injected upstream bearer to an attacker-chosen host such
// as the cloud metadata endpoint, loopback, or an RFC1918 address. The forward
// init pins `redirect: "manual"`, so fetch returns the 3xx itself and the relay
// passes that status and body straight back to the caller. These tests prove the
// upstream fetch is called exactly once (only the first hop, never the Location
// host) and the 3xx is relayed, while a normal 200 still forwards.
import { describe, it, expect, vi } from "vitest";
import {
  createDataProxy,
  mintResourceToken,
  type DnsLookupAll,
} from "../src/index";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";
const RESOURCE_A = "resource-aaaa-1111";

/** Every host resolves to one public address (no network). */
function publicDnsStub(): DnsLookupAll {
  return vi.fn(async (_host: string) => [{ address: "93.184.216.34", family: 4 }]);
}

function containerRequest(target: string, token: string): Request {
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

describe("H1 redirect-following SSRF", () => {
  it("does NOT follow a 302 to the metadata endpoint: upstream fetch is called exactly once and the 3xx is relayed", async () => {
    const METADATA = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
    // The allowlisted upstream answers with a redirect to the metadata host. A
    // naive "follow" mode would issue a SECOND fetch to 169.254.169.254 with the
    // injected bearer attached. With manual redirect the proxy must not.
    const upstreamFetch = vi.fn(async (url: string, init?: RequestInit) => {
      // Guard the test itself: assert no call ever targets the metadata host.
      expect(String(url)).not.toContain("169.254.169.254");
      // Confirm the manual redirect mode reached the forward init.
      expect((init as RequestInit | undefined)?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: METADATA },
      });
    });
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest("https://api.openai.com/v1/chat/completions", token),
    );
    // Exactly one outbound fetch: the first hop only. No follow to the metadata host.
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(String(upstreamFetch.mock.calls[0]![0])).toContain("api.openai.com");
    // The 3xx itself is relayed back to the caller verbatim.
    expect(res.status).toBe(302);
  });

  it("does NOT follow a 301 to loopback: still a single first-hop fetch", async () => {
    const upstreamFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(null, {
        status: 301,
        headers: { location: "http://127.0.0.1:8788/internal" },
      }),
    );
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest("https://api.openai.com/v1/chat/completions", token),
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(String(upstreamFetch.mock.calls[0]![0])).not.toContain("127.0.0.1");
    expect(res.status).toBe(301);
  });

  it("a normal 200 still forwards (the hardening is additive)", async () => {
    const upstreamFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createDataProxy({
      tokenSecret: SECRET,
      allowlist: ["api.openai.com"],
      upstreamFetch: upstreamFetch as unknown as typeof fetch,
      dnsLookup: publicDnsStub(),
    });
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const res = await app.request(
      containerRequest("https://api.openai.com/v1/chat/completions", token),
    );
    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});
