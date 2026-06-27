// gate-bundle.test.ts - the PRE-BUILD fail-closed static gate for GENERATED
// (untrusted) bundles (deploy plane B), source-only / no Docker / no host.
//
// SECURITY: gateGeneratedBundle runs the @utter/sandbox prepublish static checks over
// the in-memory bundle and THROWS a typed BundleGateError BEFORE any esbuild/build, so
// a malicious bundle is rejected before any artifact is produced. The malicious DoD
// fixture (sandbox test/fixtures/malicious/handler.ts) is read SOURCE-ONLY and never
// executed here.
//
// Under test:
//   (a) benign passes (no throw)
//   (b) malicious is rejected with a BundleGateError naming the net import + env enum
//   (c) gate precedes build: a guarded prepare sequence rejects with ZERO build calls
//   (d) fail-closed: an erroring static check throws BundleGateError (never passes)
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateGeneratedBundle, BundleGateError } from "../src/gate-bundle";
import * as gateModule from "../src/gate-bundle";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read the benign generated-handler fixture source (source-only, never executed). */
function benignBundle(): Record<string, string> {
  return {
    "handler.ts": readFileSync(resolve(HERE, "fixtures/generated-benign/handler.ts"), "utf8"),
  };
}

/** Read the adversarial malicious fixture SOURCE (never imported, never executed). */
function maliciousBundle(): Record<string, string> {
  return {
    "handler.ts": readFileSync(
      resolve(HERE, "../../sandbox/test/fixtures/malicious/handler.ts"),
      "utf8",
    ),
  };
}

describe("gateGeneratedBundle (pre-build fail-closed static gate)", () => {
  it("(a) does NOT throw for a benign generated bundle", () => {
    expect(() => gateGeneratedBundle(benignBundle())).not.toThrow();
  });

  it("(b) rejects the malicious fixture with a BundleGateError naming the violations", () => {
    let caught: unknown;
    try {
      gateGeneratedBundle(maliciousBundle());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleGateError);
    const gateErr = caught as BundleGateError;
    // The malicious fixture trips the `net` disallowed-import + process.env enumeration.
    const rules = gateErr.violations.map((v) =>
      v.kind === "import" ? v.rule : v.rule,
    );
    expect(rules).toContain("disallowed-import");
    expect(rules).toContain("process-env-enumeration");
    // The message names the violations so the failure is actionable.
    expect(gateErr.message).toMatch(/violation/i);
  });

  it("(c) the gate precedes the build: a malicious bundle rejects with ZERO build calls", async () => {
    // A wrapping spy over the build helper; the guard calls it ONLY after the gate passes.
    const buildSpy = vi.fn(async () => ({ bundleDir: "x", dockerfilePath: "y" }));

    // The guarded deploy-prep: gate FIRST, build only on success.
    async function prepareGenerated(bundle: Record<string, string>) {
      gateGeneratedBundle(bundle);
      return buildSpy();
    }

    await expect(prepareGenerated(maliciousBundle())).rejects.toBeInstanceOf(BundleGateError);
    // Proof the gate blocked BEFORE any build ran.
    expect(buildSpy).toHaveBeenCalledTimes(0);
  });

  it("(d) fails CLOSED: an erroring static check throws BundleGateError, never passes", () => {
    // Force the underlying gate call to throw, simulating a parse error inside the scan.
    const spy = vi
      .spyOn(gateModule, "runStaticChecksForGate")
      .mockImplementation(() => {
        throw new Error("static check exploded");
      });
    try {
      expect(() => gateGeneratedBundle(benignBundle())).toThrow(BundleGateError);
    } finally {
      spy.mockRestore();
    }
  });
});
