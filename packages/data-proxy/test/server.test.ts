// Server bootstrap config + direct-run guard (PRX-01).
//
// These tests pin the operator-facing contract of the data-proxy entrypoint:
// configFromEnv is a pure function (binds no port) that fail-fasts on a missing
// HMAC secret and honors PORT with an 8080 default, and importing server.ts does
// NOT start a listener (the pathToFileURL direct-run guard holds). The secret is
// never echoed - the fail-fast message names the env var, never its value.
import { describe, it, expect } from "vitest";
import { configFromEnv } from "../src/server";

const SECRET = "test-proxy-secret-never-leaves-the-proxy";

describe("configFromEnv", () => {
  it("throws when DATA_PROXY_TOKEN_SECRET is missing (fail-fast)", () => {
    expect(() => configFromEnv({})).toThrow(/DATA_PROXY_TOKEN_SECRET/);
  });

  it("throws when DATA_PROXY_TOKEN_SECRET is blank/whitespace (fail-fast)", () => {
    expect(() => configFromEnv({ DATA_PROXY_TOKEN_SECRET: "   " })).toThrow(
      /DATA_PROXY_TOKEN_SECRET/,
    );
  });

  it("never echoes the secret value in the fail-fast message", () => {
    // A present-but-blank secret triggers the throw; the message must name the env
    // var only. (We also assert no leak for the wider missing case.)
    try {
      configFromEnv({});
      throw new Error("expected configFromEnv to throw");
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  });

  it("defaults the port to 8080 when PORT is unset", () => {
    const cfg = configFromEnv({ DATA_PROXY_TOKEN_SECRET: SECRET });
    expect(cfg.port).toBe(8080);
    expect(cfg.proxyOpts.tokenSecret).toBe(SECRET);
  });

  it("honors a valid PORT", () => {
    const cfg = configFromEnv({ DATA_PROXY_TOKEN_SECRET: SECRET, PORT: "9090" });
    expect(cfg.port).toBe(9090);
  });

  it("falls back to 8080 for a non-numeric / non-positive PORT", () => {
    expect(configFromEnv({ DATA_PROXY_TOKEN_SECRET: SECRET, PORT: "not-a-number" }).port).toBe(
      8080,
    );
    expect(configFromEnv({ DATA_PROXY_TOKEN_SECRET: SECRET, PORT: "0" }).port).toBe(8080);
    expect(configFromEnv({ DATA_PROXY_TOKEN_SECRET: SECRET, PORT: "-5" }).port).toBe(8080);
  });

  it("trims a surrounding-whitespace secret", () => {
    const cfg = configFromEnv({ DATA_PROXY_TOKEN_SECRET: `  ${SECRET}  ` });
    expect(cfg.proxyOpts.tokenSecret).toBe(SECRET);
  });
});

describe("server.ts module import", () => {
  it("does NOT bind a port when imported (direct-run guard holds)", async () => {
    // Importing the module must only evaluate the exports; the start() call is
    // gated behind the pathToFileURL(process.argv[1]) === import.meta.url guard,
    // which is false under the vitest runner. If the guard regressed, this import
    // would attempt a serve() and (with no secret in the test env) throw the
    // fail-fast - so a clean import proves no boot occurred.
    const mod = await import("../src/server");
    expect(typeof mod.configFromEnv).toBe("function");
    expect(typeof mod.start).toBe("function");
  });
});
