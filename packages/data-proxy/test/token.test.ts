// Token mint/verify + server-side credential mapping (SBX-03, PRX-01).
//
// These tests pin the load-bearing security properties of the scoped-token
// scheme: the container holds ONLY a short-lived `aud=resourceId` JWT (HS256,
// secret stays on the proxy), and the real upstream credential is resolved
// SERVER-SIDE and never appears in the token payload the container holds.
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  mintResourceToken,
  verifyResourceToken,
  resolveUpstreamCredential,
} from "../src/index";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";
const RESOURCE_A = "resource-aaaa-1111";
const RESOURCE_B = "resource-bbbb-2222";

describe("mintResourceToken / verifyResourceToken", () => {
  it("mints a token that verifies for the same resource + secret (happy path)", () => {
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    expect(typeof token).toBe("string");
    expect(verifyResourceToken(token, RESOURCE_A, SECRET)).toBe(true);
  });

  it("rejects a token minted for resource A when verified for resource B (aud binding)", () => {
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    expect(verifyResourceToken(token, RESOURCE_B, SECRET)).toBe(false);
  });

  it("rejects an expired token (tight TTL)", () => {
    // A 0/negative TTL produces an already-expired token (exp <= iat). jsonwebtoken
    // marks it expired immediately, so verify must catch -> false.
    const token = mintResourceToken(RESOURCE_A, -10, SECRET);
    expect(verifyResourceToken(token, RESOURCE_A, SECRET)).toBe(false);
  });

  it("rejects a token signed with a different secret (HS256, secret stays on proxy)", () => {
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    expect(verifyResourceToken(token, RESOURCE_A, "a-different-secret")).toBe(false);
  });

  it("rejects a tampered / garbage token", () => {
    expect(verifyResourceToken("not.a.jwt", RESOURCE_A, SECRET)).toBe(false);
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(verifyResourceToken(tampered, RESOURCE_A, SECRET)).toBe(false);
  });

  it("rejects a token forged with a non-HS256 algorithm (alg confusion guard)", () => {
    // 'none' alg tokens must never verify; we pin algorithms:['HS256'].
    const forged = jwt.sign({ aud: RESOURCE_A }, "", { algorithm: "none" });
    expect(verifyResourceToken(forged, RESOURCE_A, SECRET)).toBe(false);
  });

  it("NEVER carries the real upstream key in the token payload", () => {
    const token = mintResourceToken(RESOURCE_A, 120, SECRET);
    const decoded = jwt.decode(token, { json: true }) as Record<string, unknown> | null;
    expect(decoded).not.toBeNull();
    // aud must bind the token; no credential material is present.
    expect(decoded?.aud).toBe(RESOURCE_A);
    const cred = resolveUpstreamCredential(RESOURCE_A);
    expect(JSON.stringify(decoded)).not.toContain(cred.realApiKey);
    expect(decoded).not.toHaveProperty("realApiKey");
    expect(decoded).not.toHaveProperty("upstreamBaseUrl");
  });
});

describe("resolveUpstreamCredential (server-side mapping)", () => {
  it("returns the server-side upstream credential for a known resource", () => {
    const cred = resolveUpstreamCredential(RESOURCE_A);
    expect(cred.upstreamBaseUrl).toMatch(/^https:\/\//);
    expect(typeof cred.realApiKey).toBe("string");
    expect(cred.realApiKey.length).toBeGreaterThan(0);
  });

  it("throws for an unknown resource (no fallback / no default cred)", () => {
    expect(() => resolveUpstreamCredential("unknown-resource-zzzz")).toThrow();
  });
});
