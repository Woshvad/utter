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
import {
  writeBundleToDir,
  bundleGeneratedHandler,
  GENERATED_BUNDLE_KEYS,
} from "../src/bundle-generated";
import { gateGeneratedBundle } from "../src/gate-bundle";

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
