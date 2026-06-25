// resource-auth-config suite (Security review C1): the FACILITATOR_AUTH_SECRET
// prod fail-fast in server.ts (mirrors the RELAYER_SIGNER_KEYS fail-fast + the
// studio SESSION_SECRET fix).
//
//   production + unset/blank/short -> throws at boot (fail-closed).
//   production + a >=32-char secret -> enforced (no throw).
//   dev/test  + unset               -> auth UNENFORCED (pass-through, no throw).
//   dev/test  + a secret            -> enforced.
//
// Each test saves and restores NODE_ENV + FACILITATOR_AUTH_SECRET so the suite is
// hermetic and never leaks env across cases.
import { describe, it, expect, afterEach } from "vitest";
import { resolveAuthConfig } from "../src/server";

const ENV_KEYS = ["NODE_ENV", "FACILITATOR_AUTH_SECRET"] as const;
const VALID_SECRET = "facilitator-auth-secret-at-least-32-chars-long";

describe("resolveAuthConfig (FACILITATOR_AUTH_SECRET prod fail-fast)", () => {
  const saved: Record<string, string | undefined> = {};

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined && !(key in saved)) saved[key] = process.env[key];
    }
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const v = saved[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
      delete saved[key];
    }
  });

  it("production + unset secret -> THROWS (fail-closed)", () => {
    setEnv({ NODE_ENV: "production", FACILITATOR_AUTH_SECRET: undefined });
    expect(() => resolveAuthConfig()).toThrow(/FACILITATOR_AUTH_SECRET/);
  });

  it("production + blank secret -> THROWS", () => {
    setEnv({ NODE_ENV: "production", FACILITATOR_AUTH_SECRET: "   " });
    expect(() => resolveAuthConfig()).toThrow();
  });

  it("production + too-short secret (<32 chars) -> THROWS", () => {
    setEnv({ NODE_ENV: "production", FACILITATOR_AUTH_SECRET: "short" });
    expect(() => resolveAuthConfig()).toThrow();
  });

  it("production + a valid >=32-char secret -> enforced, no throw", () => {
    setEnv({ NODE_ENV: "production", FACILITATOR_AUTH_SECRET: VALID_SECRET });
    const cfg = resolveAuthConfig();
    expect(cfg.authEnforced).toBe(true);
    expect(cfg.authSecret).toBe(VALID_SECRET);
  });

  it("dev/test + unset secret -> UNENFORCED (no throw, pass-through)", () => {
    setEnv({ NODE_ENV: "test", FACILITATOR_AUTH_SECRET: undefined });
    const cfg = resolveAuthConfig();
    expect(cfg.authEnforced).toBe(false);
    expect(cfg.authSecret).toBeUndefined();
  });

  it("dev/test + a secret -> enforced (so the enforced path is exercisable locally)", () => {
    setEnv({ NODE_ENV: "development", FACILITATOR_AUTH_SECRET: VALID_SECRET });
    const cfg = resolveAuthConfig();
    expect(cfg.authEnforced).toBe(true);
    expect(cfg.authSecret).toBe(VALID_SECRET);
  });

  it("never includes the secret in the thrown error message", () => {
    setEnv({ NODE_ENV: "production", FACILITATOR_AUTH_SECRET: "this-short-secret-must-not-leak" });
    try {
      resolveAuthConfig();
      throw new Error("expected resolveAuthConfig to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("this-short-secret-must-not-leak");
    }
  });
});
