// example-bundle.test.ts - the autonomous off-host guard for the committed SAMPLE
// untrusted generated bundle (services/deployer/examples/generated-sample), no Docker /
// no host.
//
// Why this exists: infrastructure/RUNBOOK.md tells the operator to point
// DEPLOY_BUNDLE_PATH at services/deployer/examples/generated-sample for the
// generated-bundle deploy. A host run is expensive (gas + real containers), so this test
// proves OFF-HOST, before any host run, that the shipped sample is (1) gate-clean and (2)
// builds a self-contained server.js. It also pins the sample's benignness: a future edit
// that smuggles a dangerous import or env enumeration fails gateGeneratedBundle here.
import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { classifyResponse } from "@utter/x402-arc";
import {
  writeBundleToDir,
  bundleGeneratedHandler,
  GENERATED_BUNDLE_KEYS,
} from "../src/bundle-generated";
import { gateGeneratedBundle } from "../src/gate-bundle";
import { handler as sampleHandler } from "../examples/generated-sample/handler";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed sample bundle dir (services/deployer/examples/generated-sample). */
const EXAMPLE_DIR = resolve(HERE, "../examples/generated-sample");

/**
 * Read the shipped sample dir into an in-memory bundle keyed by GENERATED_BUNDLE_KEYS.
 * Only the keys actually present are included (a per-key absent file is skipped, exactly
 * as deployGeneratedBundle does when it loads an on-disk bundle).
 */
function readExampleBundle(): Record<string, string> {
  const bundle: Record<string, string> = {};
  for (const key of GENERATED_BUNDLE_KEYS) {
    try {
      bundle[key] = readFileSync(resolve(EXAMPLE_DIR, key), "utf8");
    } catch {
      // Per-key absent (ENOENT): the sample ships no Dockerfile, so skip it.
    }
  }
  return bundle;
}

describe("the shipped generated-sample bundle (off-host guard)", () => {
  it("passes the pre-build gate (it is benign and gate-clean)", () => {
    const bundle = readExampleBundle();
    // handler.ts must be present, or the sample is broken.
    expect(bundle["handler.ts"]).toBeTruthy();
    expect(() => gateGeneratedBundle(bundle)).not.toThrow();
  });

  it("builds a self-contained server.js off-host", async () => {
    const bundle = readExampleBundle();
    const dir = await mkdtemp(join(tmpdir(), "utter-example-bundle-"));
    try {
      await writeBundleToDir(bundle, dir);
      const { bundleDir, dockerfilePath } = await bundleGeneratedHandler(dir);

      const serverJs = await readFile(join(bundleDir, "server.js"), "utf8");
      // Non-trivial: hono + the generated handler are inlined into one server.js.
      expect(serverJs.length).toBeGreaterThan(5_000);
      // The generated handler's success shape is inlined (it references `length`).
      expect(serverJs).toContain("length");
      // The generated handler is inlined, never required at runtime.
      expect(serverJs).not.toMatch(/require\(["']@utter\//);
      expect(serverJs).not.toMatch(/from\s+["']@utter\//);

      const dockerfile = await readFile(dockerfilePath, "utf8");
      // The SAME no-install Dockerfile echo uses: self-contained, no npm ci step.
      expect(dockerfile).toContain('CMD ["node", "server.js"]');
      expect(dockerfile).not.toContain("npm ci");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The handler<->classifier contract. The sidecar response gate runs the handler then
// validates its body against the bundle's openapi.json; a shape mismatch is classified
// a malfunction (502 response_failed_validation, NO debit) on the host. These cases run
// the shipped sample handler and classify its REAL output with the SAME classifier the
// sidecar uses, so a handler/classifier drift fails here off-host instead of as a live
// 502. (This guard was added after a host run surfaced a { result } vs { echo } mismatch.)
describe("the sample handler's output validates against its own openapi classifier", () => {
  /** Mount the sample handler on /echo (the route the deploy probe POSTs to). */
  function appWithSampleHandler(): Hono {
    const app = new Hono();
    app.post("/echo", (c) => sampleHandler(c));
    return app;
  }

  /** The sample bundle's openapi doc, parsed (the classifier schema source). */
  function sampleOpenapi(): Record<string, unknown> {
    const raw = readFileSync(resolve(EXAMPLE_DIR, "openapi.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("classifies a success body (text -> 200) as 'success'", async () => {
    const res = await appWithSampleHandler().request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "live" }),
    });
    expect(res.status).toBe(200);
    // The exact check the sidecar does live: classify the handler's real body.
    expect(classifyResponse(sampleOpenapi(), await res.json())).toBe("success");
  });

  it("classifies a bad-input body (non-string text -> 400) as 'declared_error'", async () => {
    const res = await appWithSampleHandler().request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 123 }),
    });
    expect(res.status).toBe(400);
    expect(classifyResponse(sampleOpenapi(), await res.json())).toBe("declared_error");
  });

  it("regression guard: the old { result, length } shape is a malfunction", () => {
    // Documents the bug this guard prevents. EchoSuccess requires { echo, length } with
    // additionalProperties:false, so { result, length } matches neither schema and the
    // gate would 502 it. The handler must return { echo, length } to stay in lockstep.
    expect(classifyResponse(sampleOpenapi(), { result: "live", length: 4 })).toBe(
      "malfunction",
    );
  });
});
