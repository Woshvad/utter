// build.test.ts - hardened build WIRING (SBX-05).
//
// Asserts the build SPEC + generated Dockerfile (no live dockerode build): the base
// image is pinned BY DIGEST (T-03-17), deps install FROM THE LOCKFILE ONLY, the
// registry source swaps via REGISTRY_MIRROR_URL (public locally; the Verdaccio
// mirror in prod - identical code), and the no-network-at-build property is
// EXPLICITLY NOT claimed locally (networkIsolation: 'operator-gated', T-03-18).
//
// It does NOT assert live network isolation - that is operator-gated on the build
// host with the internal mirror. The autonomous path runs `buildResourceImage`
// WITHOUT a dockerode instance, so it returns the spec without launching a build.
import { describe, it, expect, afterEach } from "vitest";
import {
  buildResourceImage,
  generateDockerfile,
  assertPinnedByDigest,
  PINNED_BASE_IMAGES,
} from "../src/build";

const ORIGINAL_MIRROR = process.env.REGISTRY_MIRROR_URL;

describe("buildResourceImage (hardened build wiring, SBX-05)", () => {
  afterEach(() => {
    // Restore the env between cases so the public-vs-mirror branch is hermetic.
    if (ORIGINAL_MIRROR === undefined) delete process.env.REGISTRY_MIRROR_URL;
    else process.env.REGISTRY_MIRROR_URL = ORIGINAL_MIRROR;
  });

  it("pins the node base image BY DIGEST (rejects a floating tag, T-03-17)", () => {
    expect(PINNED_BASE_IMAGES.node).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(PINNED_BASE_IMAGES.python).toMatch(/@sha256:[0-9a-f]{64}$/);
    // A floating (unpinned) tag is a build error, never a silent fallback.
    expect(() => assertPinnedByDigest("node:22-bookworm-slim")).toThrow(/not pinned by digest/);
    expect(() => assertPinnedByDigest(PINNED_BASE_IMAGES.node)).not.toThrow();
  });

  it("generates a Dockerfile that FROMs the pinned digest and installs from the lockfile", () => {
    const dockerfile = generateDockerfile({
      runtime: "node",
      baseImage: PINNED_BASE_IMAGES.node,
      registryUrl: "",
    });
    expect(dockerfile).toContain(`FROM ${PINNED_BASE_IMAGES.node}`);
    // Install is pinned to the lockfile (npm ci), never an unpinned `npm install`.
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("pnpm-lock.yaml");
    expect(dockerfile).not.toContain("npm install");
  });

  it("swaps the registry via REGISTRY_MIRROR_URL (empty -> public, set -> mirror)", async () => {
    // Empty env -> public registry (no npm_config_registry override baked in).
    delete process.env.REGISTRY_MIRROR_URL;
    const local = await buildResourceImage("/tmp/bundle", { runtime: "node", tag: "resource-x:v1" });
    expect(local.registryUrl).toBe("");
    expect(local.dockerfile).not.toContain("npm_config_registry=");
    expect(local.dockerfile).toContain("public registry");

    // Set env -> the mirror URL is baked into the install step (identical code path).
    process.env.REGISTRY_MIRROR_URL = "http://verdaccio.internal:4873";
    const prod = await buildResourceImage("/tmp/bundle", { runtime: "node", tag: "resource-x:v1" });
    expect(prod.registryUrl).toBe("http://verdaccio.internal:4873");
    expect(prod.dockerfile).toContain("npm_config_registry=http://verdaccio.internal:4873");

    // An explicit opt overrides the env.
    const explicit = await buildResourceImage("/tmp/bundle", {
      runtime: "node",
      tag: "resource-x:v1",
      registryMirrorUrl: "http://other.mirror:4873",
    });
    expect(explicit.registryUrl).toBe("http://other.mirror:4873");
  });

  it("NEVER claims the no-network-at-build property locally (operator-gated, T-03-18)", async () => {
    const result = await buildResourceImage("/tmp/bundle", { runtime: "node", tag: "resource-x:v1" });
    // The build did not run a live image (no dockerode) - this is the spec path.
    expect(result.built).toBe(false);
    // The network-isolation posture is ALWAYS operator-gated from this code path.
    expect(result.networkIsolation).toBe("operator-gated");
    // The Dockerfile self-documents the operator-gated posture.
    expect(result.dockerfile).toContain("operator-gated");
  });

  it("applies build-time + image-size caps (T-03-19)", async () => {
    const result = await buildResourceImage("/tmp/bundle", {
      runtime: "node",
      tag: "resource-x:v1",
      buildTimeoutSeconds: 120,
      maxImageBytes: 64 * 1024 * 1024,
    });
    expect(result.buildTimeoutSeconds).toBe(120);
    expect(result.maxImageBytes).toBe(64 * 1024 * 1024);
  });

  it("generates a python Dockerfile pinned by digest with --require-hashes lockfile install", () => {
    const dockerfile = generateDockerfile({
      runtime: "python",
      baseImage: PINNED_BASE_IMAGES.python,
      registryUrl: "",
    });
    expect(dockerfile).toContain(`FROM ${PINNED_BASE_IMAGES.python}`);
    expect(dockerfile).toContain("--require-hashes");
    expect(dockerfile).toContain("requirements.lock");
  });
});
