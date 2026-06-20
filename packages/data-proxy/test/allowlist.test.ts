// Host allowlist + SSRF normalization (PRX-02).
//
// Pins the OWASP SSRF guidance the proxy enforces: upstream allowance is an
// ALLOWLIST (default-deny, never a denylist), and the requested host is
// NORMALIZED THEN VALIDATED against the link-local/metadata/private/loopback
// block set BEFORE the allowlist check — so obfuscated forms (decimal/hex IP,
// trailing dot, uppercase) cannot smuggle a private target past the gate.
import { describe, it, expect } from "vitest";
import { isAllowlisted, normalizeAndCheckHost } from "../src/index";

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
