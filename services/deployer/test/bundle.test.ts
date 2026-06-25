// bundle.test.ts - the sidecar-topology bundlers (wave BC1): bundleEchoHandler (the
// gate-less handler image) and bundleSidecar (the trusted gate-server image).
//
// Each must produce a self-contained server.js (no leftover @utter/* require - the
// workspace pkg is inlined) plus a prebundled Dockerfile whose FROM is digest-pinned
// (assertPinnedByDigest passes for the resolved base) and whose CMD is node server.js.
// The existing bundleEcho tests live in bundle-echo.test.ts and stay green.
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBaseImage, PINNED_BASE_IMAGES, assertPinnedByDigest } from "../src/build";
import { bundleEchoHandler, bundleSidecar } from "../src/bundle-echo";

const NODE_OVERRIDE = "DEPLOY_BASE_IMAGE_NODE";
const ORIGINAL_NODE = process.env[NODE_OVERRIDE];

/** Assert a bundle dir holds a self-contained server.js + a digest-pinned Dockerfile. */
async function assertSelfContainedBundle(bundleDir: string, dockerfilePath: string) {
  const serverJs = await readFile(join(bundleDir, "server.js"), "utf8");
  // Non-trivial (viem/hono/gate are inlined, so this is large).
  expect(serverJs.length).toBeGreaterThan(10_000);
  // The workspace pkg must be INLINED, not required at runtime.
  expect(serverJs).not.toMatch(/require\(["']@utter\//);
  expect(serverJs).not.toMatch(/from\s+["']@utter\//);

  const dockerfile = await readFile(dockerfilePath, "utf8");
  // FROM is the resolved base; the resolved base must be pinned BY DIGEST.
  const base = resolveBaseImage("node");
  expect(dockerfile).toContain(`FROM ${base}`);
  expect(() => assertPinnedByDigest(base)).not.toThrow();
  expect(base).toBe(PINNED_BASE_IMAGES.node);
  expect(dockerfile).toContain('CMD ["node", "server.js"]');
  expect(dockerfile).toContain("USER node");
}

describe("bundleEchoHandler (gate-less handler image: self-contained + digest-pinned)", () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "utter-handler-bundle-"));
  });
  afterEach(() => {
    if (ORIGINAL_NODE === undefined) delete process.env[NODE_OVERRIDE];
    else process.env[NODE_OVERRIDE] = ORIGINAL_NODE;
  });

  it("produces a self-contained server.js + digest-pinned Dockerfile, CMD node server.js", async () => {
    delete process.env[NODE_OVERRIDE];
    const { bundleDir, dockerfilePath } = await bundleEchoHandler({ outDir, port: 8080 });
    await assertSelfContainedBundle(bundleDir, dockerfilePath);
    expect(await readFile(dockerfilePath, "utf8")).toContain("EXPOSE 8080");
  });
});

describe("bundleSidecar (trusted gate-server image: self-contained + digest-pinned)", () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "utter-sidecar-bundle-"));
  });
  afterEach(() => {
    if (ORIGINAL_NODE === undefined) delete process.env[NODE_OVERRIDE];
    else process.env[NODE_OVERRIDE] = ORIGINAL_NODE;
  });

  it("produces a self-contained server.js + digest-pinned Dockerfile, CMD node server.js", async () => {
    delete process.env[NODE_OVERRIDE];
    const { bundleDir, dockerfilePath } = await bundleSidecar({ outDir, port: 8080 });
    await assertSelfContainedBundle(bundleDir, dockerfilePath);
    expect(await readFile(dockerfilePath, "utf8")).toContain("EXPOSE 8080");
  });
});
