// live-deploy.test.ts - the AUTONOMOUS deploy-glue security proofs (deploy plane B).
//
// NO docker, NO chain, NO host. These assert the UNTRUSTED-bundle handling of the
// generated-bundle deploy glue WITHOUT ever running a deploy end-to-end:
//   (a) deployGeneratedBundle GATES the bundle FIRST, fails closed (BundleGateError),
//       and makes ZERO downstream writeBundleToDir / deployResource calls for a
//       MALICIOUS on-disk bundle - even with DEPLOY_SLUG set so it would otherwise
//       proceed (gate-before-build in the glue, mirroring gate-bundle.test.ts (c)).
//   (b) bundleGeneratedHandler structurally RE-GATES the on-disk bundle at its top: a
//       malicious on-disk handler.ts throws BundleGateError and writes NO server.js
//       (defense in depth - no build path can produce server.js for an ungated bundle).
//
// The malicious DoD fixture (services/sandbox/test/fixtures/malicious/handler.ts) is
// read SOURCE-ONLY and never executed. The benign on-disk -> server.js path stays
// proven by bundle-generated.test.ts (not duplicated here).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BundleGateError } from "../src/gate-bundle";
import { bundleGeneratedHandler } from "../src/bundle-generated";
import * as bundleGen from "../src/bundle-generated";
import * as liveDeploy from "../src/live-deploy";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read the adversarial malicious fixture SOURCE (never imported, never executed). */
function maliciousHandlerSource(): string {
  return readFileSync(
    resolve(HERE, "../../sandbox/test/fixtures/malicious/handler.ts"),
    "utf8",
  );
}

const EMPTY_OPENAPI = JSON.stringify({ openapi: "3.1.0", paths: {} });

describe("deployGeneratedBundle (gate-before-build, fail closed)", () => {
  const savedSlug = process.env.DEPLOY_SLUG;
  afterEach(() => {
    if (savedSlug === undefined) delete process.env.DEPLOY_SLUG;
    else process.env.DEPLOY_SLUG = savedSlug;
    vi.restoreAllMocks();
  });

  it("(a) rejects a MALICIOUS bundle with BundleGateError and makes ZERO writeBundleToDir / deployResource calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-gen-deploy-mal-"));
    try {
      // A malicious on-disk bundle (the gate must reject it before any write/build).
      writeFileSync(join(dir, "handler.ts"), maliciousHandlerSource(), "utf8");
      writeFileSync(join(dir, "openapi.json"), EMPTY_OPENAPI, "utf8");

      // Set DEPLOY_SLUG so the glue would otherwise proceed past the spec build: the
      // ONLY thing that must stop it is the gate.
      process.env.DEPLOY_SLUG = "gen";

      // Spy on the downstream work: neither must be reached when the gate rejects.
      const writeSpy = vi.spyOn(bundleGen, "writeBundleToDir");
      const deploySpy = vi.spyOn(liveDeploy, "deployResource");

      await expect(liveDeploy.deployGeneratedBundle(dir)).rejects.toBeInstanceOf(
        BundleGateError,
      );
      // Proof the gate blocked BEFORE any write or deploy ran.
      expect(writeSpy).toHaveBeenCalledTimes(0);
      expect(deploySpy).toHaveBeenCalledTimes(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bundleGeneratedHandler structural gate (defense in depth)", () => {
  it("(b) re-gates the on-disk bundle: a malicious handler.ts throws BundleGateError and writes NO server.js", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-gen-struct-gate-"));
    try {
      // A malicious on-disk handler.ts + a benign openapi. bundleGeneratedHandler must
      // re-gate the dir at its top, BEFORE writing the shim or running esbuild.
      writeFileSync(join(dir, "handler.ts"), maliciousHandlerSource(), "utf8");
      writeFileSync(join(dir, "openapi.json"), EMPTY_OPENAPI, "utf8");

      await expect(bundleGeneratedHandler(dir)).rejects.toBeInstanceOf(BundleGateError);
      // No server.js was produced for the ungated bundle (the gate fired before esbuild).
      await expect(stat(join(dir, "server.js"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
