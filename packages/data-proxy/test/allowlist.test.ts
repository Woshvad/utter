// Host allowlist + SSRF normalization (PRX-02).
//
// Pins the OWASP SSRF guidance the proxy enforces: upstream allowance is an
// ALLOWLIST (default-deny, never a denylist), and the requested host is
// NORMALIZED THEN VALIDATED against the link-local/metadata/private/loopback
// block set BEFORE the allowlist check — so obfuscated forms (decimal/hex IP,
// trailing dot, uppercase) cannot smuggle a private target past the gate.
import { describe, it, expect, vi } from "vitest";
import {
  isAllowlisted,
  normalizeAndCheckHost,
  resolveAndCheckHost,
  type DnsLookupAll,
} from "../src/index";

describe("isAllowlisted (default-deny allowlist semantics)", () => {
  it("passes a host on the allowlist", () => {
    expect(isAllowlisted("api.openai.com")).toBe(true);
  });

  it("rejects a host not on the allowlist (default deny)", () => {
    expect(isAllowlisted("evil.example.com")).toBe(false);
  });

  it("is case-insensitive on the host", () => {
    expect(isAllowlisted("API.OpenAI.com")).toBe(true);
  });

  it("does NOT pass a subdomain spoof of an allowlisted host", () => {
    // api.openai.com.evil.com must not match api.openai.com.
    expect(isAllowlisted("api.openai.com.evil.com")).toBe(false);
  });
});

describe("normalizeAndCheckHost (normalize-then-validate, SSRF block set)", () => {
  it("accepts an allowlisted upstream URL and returns its host", () => {
    const r = normalizeAndCheckHost("https://api.openai.com/v1/chat/completions");
    expect(r.ok).toBe(true);
    expect(r.host).toBe("api.openai.com");
  });

  it("rejects the cloud metadata IP 169.254.169.254", () => {
    expect(normalizeAndCheckHost("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  it("rejects RFC1918 private ranges", () => {
    expect(normalizeAndCheckHost("http://10.0.0.1/").ok).toBe(false);
    expect(normalizeAndCheckHost("http://172.16.5.4/").ok).toBe(false);
    expect(normalizeAndCheckHost("http://192.168.1.1/").ok).toBe(false);
  });

  it("rejects loopback (127/8) and localhost", () => {
    expect(normalizeAndCheckHost("http://127.0.0.1/").ok).toBe(false);
    expect(normalizeAndCheckHost("http://localhost/").ok).toBe(false);
  });

  it("rejects obfuscated decimal-IP form of the metadata address", () => {
    // 169.254.169.254 == 2852039166 decimal. Normalize THEN validate must catch it.
    expect(normalizeAndCheckHost("http://2852039166/").ok).toBe(false);
  });

  it("rejects obfuscated hex-IP form of loopback", () => {
    // 127.0.0.1 == 0x7f000001.
    expect(normalizeAndCheckHost("http://0x7f000001/").ok).toBe(false);
  });

  it("rejects an octal-obfuscated loopback literal (WR-02)", () => {
    // 0177.0.0.1 is octal 127.0.0.1; a single-component octal 017700000001 too.
    // Both are numeric-looking hosts and MUST be rejected (never read as a public
    // host by mis-parsing the radix).
    expect(normalizeAndCheckHost("http://0177.0.0.1/").ok).toBe(false);
    expect(normalizeAndCheckHost("http://017700000001/").ok).toBe(false);
  });

  it("rejects a dotted-hex obfuscated IP form (WR-02)", () => {
    // 0x7f.0x0.0x0.0x1 == 127.0.0.1; every component is numeric -> reject.
    expect(normalizeAndCheckHost("http://0x7f.0x0.0x0.0x1/").ok).toBe(false);
  });

  it("rejects a bare public dotted-quad (an IP literal is never an allowlisted DNS host)", () => {
    expect(normalizeAndCheckHost("http://93.184.216.34/").ok).toBe(false);
  });

  it("rejects a trailing-dot / uppercase obfuscation of localhost", () => {
    expect(normalizeAndCheckHost("http://LOCALHOST./").ok).toBe(false);
  });

  it("rejects an allowlisted-looking host with a trailing dot that is actually private", () => {
    expect(normalizeAndCheckHost("http://10.0.0.1./").ok).toBe(false);
  });

  it("rejects a well-formed but non-allowlisted public host (default deny)", () => {
    const r = normalizeAndCheckHost("https://evil.example.com/steal");
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(normalizeAndCheckHost("not a url").ok).toBe(false);
    expect(normalizeAndCheckHost("").ok).toBe(false);
  });

  it("is data-driven: passing a custom allowlist changes only the data, not the logic", () => {
    const r = normalizeAndCheckHost("https://api.weather.example.com/forecast", [
      "api.weather.example.com",
    ]);
    expect(r.ok).toBe(true);
    // The default allowlist would have rejected this host.
    expect(normalizeAndCheckHost("https://api.weather.example.com/forecast").ok).toBe(false);
  });
});

describe("resolveAndCheckHost (resolved-IP re-check, CR-02 / DNS rebinding)", () => {
  it("ACCEPTS an allowlisted host that resolves to a public address and returns the validated IP", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const r = await resolveAndCheckHost("https://api.openai.com/v1/x", undefined, stub);
    expect(r.ok).toBe(true);
    expect(r.host).toBe("api.openai.com");
    expect(r.addresses?.[0]?.address).toBe("93.184.216.34");
  });

  it("REJECTS an allowlisted host stubbed to resolve to 169.254.169.254 (metadata)", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]);
    const r = await resolveAndCheckHost("https://api.openai.com/", undefined, stub);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("resolved_to_blocked");
  });

  it("REJECTS an allowlisted host stubbed to resolve to RFC1918 10.x", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    expect((await resolveAndCheckHost("https://api.openai.com/", undefined, stub)).ok).toBe(false);
  });

  it("REJECTS an allowlisted host stubbed to resolve to loopback 127.0.0.1", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    expect((await resolveAndCheckHost("https://api.openai.com/", undefined, stub)).ok).toBe(false);
  });

  it("REJECTS an allowlisted host stubbed to resolve to IPv6 loopback ::1", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [{ address: "::1", family: 6 }]);
    expect((await resolveAndCheckHost("https://api.openai.com/", undefined, stub)).ok).toBe(false);
  });

  it("REJECTS an allowlisted host stubbed to resolve to an IPv4-mapped metadata IPv6 address", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [
      { address: "::ffff:169.254.169.254", family: 6 },
    ]);
    expect((await resolveAndCheckHost("https://api.openai.com/", undefined, stub)).ok).toBe(false);
  });

  it("REJECTS when the pre-filter already fails (non-allowlisted host never resolves)", async () => {
    const stub: DnsLookupAll = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const r = await resolveAndCheckHost("https://evil.example.com/", undefined, stub);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("pre_filter");
    // A rejected pre-filter must NOT have triggered a DNS lookup.
    expect(stub).not.toHaveBeenCalled();
  });

  it("REJECTS when DNS resolution fails (fail closed)", async () => {
    const stub: DnsLookupAll = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const r = await resolveAndCheckHost("https://api.openai.com/", undefined, stub);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("resolve_failed");
  });

  it("REJECTS when resolution yields no addresses", async () => {
    const stub: DnsLookupAll = vi.fn(async () => []);
    const r = await resolveAndCheckHost("https://api.openai.com/", undefined, stub);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_addresses");
  });
});
