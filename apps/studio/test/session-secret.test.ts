// session-secret.test.ts - fail-closed SESSION_SECRET in production.
//
// sessionSecret() is the lazy resolver for the cookie HMAC key. In production it MUST
// refuse to fall back to the committed dev constant (a publicly known key would let
// anyone forge a session cookie and bypass requireCreator); outside production it keeps
// a working dev fallback so local dev and the autonomous suite run without a real
// secret. These tests save/restore NODE_ENV and SESSION_SECRET so they leak no state.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sessionSecret } from "../app/auth/session.server";

describe("SESSION_SECRET fail-closed", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    // start each case from a clean slate (no inherited secret)
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    // restore the surrounding environment exactly so other suites are unaffected
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSecret;
  });

  it("throws in production when SESSION_SECRET is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SESSION_SECRET;
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("throws in production when SESSION_SECRET is too short (< 32 chars)", () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "short";
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("throws in production when SESSION_SECRET is whitespace only", () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "   ";
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("returns the provided secret in production when it is >= 32 chars", () => {
    process.env.NODE_ENV = "production";
    const real = "a-real-production-secret-that-is-long-enough-1234";
    process.env.SESSION_SECRET = real;
    expect(sessionSecret()).toBe(real);
  });

  it("returns a non-empty fallback in test/dev when no secret is set (no throw)", () => {
    process.env.NODE_ENV = "test";
    delete process.env.SESSION_SECRET;
    const out = sessionSecret();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    // the dev fallback must never be returned in production, but here it is fine
    expect(out).not.toBe("");
  });

  it("returns the provided secret in test/dev when one is set", () => {
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
    expect(sessionSecret()).toBe("test-session-secret-which-is-long-enough-32b");
  });
});
