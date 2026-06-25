// bundle-echo.test.ts - the echo bundler + env-overridable base digests (deploy
// plane B).
//
// Three things under test:
//   1. resolveBaseImage honors the DEPLOY_BASE_IMAGE_NODE override and falls back to
//      the pinned constant (an operator pins the real scanned digest via env, not code).
//   2. bundleEcho writes a NON-TRIVIAL self-contained server.js (no leftover
//      `require("@utter/` or `from "@utter/` - proves the workspace pkg is inlined)
//      and a prebundled Dockerfile whose FROM is the resolved digest and whose CMD is
//      `node server.js`.
//   3. REAL local smoke (no Docker): `node <bundle>/server.js` boots and 402s an
//      unpaid POST /echo - the gate 402s on a missing X-PAYMENT BEFORE any facilitator
//      call, so this works fully offline. This proves the bundle is self-contained,
//      boots, and gates.
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolveBaseImage, PINNED_BASE_IMAGES } from "../src/build";
import { bundleEcho } from "../src/bundle-echo";

const NODE_OVERRIDE = "DEPLOY_BASE_IMAGE_NODE";
const ORIGINAL_NODE = process.env[NODE_OVERRIDE];
// A syntactically valid pinned-by-digest override (the digest content is arbitrary).
const OVERRIDE_DIGEST =
  "node:22-bookworm-slim@sha256:abc1230000000000000000000000000000000000000000000000000000000000";

describe("resolveBaseImage (env override, deploy plane B)", () => {
  afterEach(() => {
    if (ORIGINAL_NODE === undefined) delete process.env[NODE_OVERRIDE];
    else process.env[NODE_OVERRIDE] = ORIGINAL_NODE;
  });

  it("falls back to the pinned constant when no override is set", () => {
    delete process.env[NODE_OVERRIDE];
    expect(resolveBaseImage("node")).toBe(PINNED_BASE_IMAGES.node);
  });

  it("honors the DEPLOY_BASE_IMAGE_NODE override when set", () => {
    process.env[NODE_OVERRIDE] = OVERRIDE_DIGEST;
    expect(resolveBaseImage("node")).toBe(OVERRIDE_DIGEST);
  });
});

describe("bundleEcho (self-contained server.js + prebundled Dockerfile)", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "utter-echo-bundle-"));
  });

  afterEach(() => {
    if (ORIGINAL_NODE === undefined) delete process.env[NODE_OVERRIDE];
    else process.env[NODE_OVERRIDE] = ORIGINAL_NODE;
  });

  it("writes a non-trivial server.js with NO leftover @utter/* requires (self-contained)", async () => {
    const { bundleDir } = await bundleEcho({ outDir });
    const serverJs = await readFile(join(bundleDir, "server.js"), "utf8");
    // Non-trivial (viem/hono/gate/handler are inlined, so this is large).
    expect(serverJs.length).toBeGreaterThan(10_000);
    // The workspace pkg must be INLINED, not required at runtime.
    expect(serverJs).not.toMatch(/require\(["']@utter\//);
    expect(serverJs).not.toMatch(/from\s+["']@utter\//);
  });

  it("writes a Dockerfile FROM the resolved digest with CMD node server.js", async () => {
    process.env[NODE_OVERRIDE] = OVERRIDE_DIGEST;
    const { dockerfilePath } = await bundleEcho({ outDir, port: 8080 });
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(`FROM ${OVERRIDE_DIGEST}`);
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain("USER node");
  });
});

/** Find a free TCP port by binding to :0 and reading the assigned port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll an unpaid POST /echo until the booted server answers (or time out). */
async function pollUnpaidEcho(port: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST" });
      return res.status;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`echo server never came up: ${String(lastErr)}`);
}

describe("bundleEcho REAL smoke (node server.js boots + 402s unpaid, no Docker)", () => {
  it("boots the bundle and returns 402 for an unpaid POST /echo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-echo-smoke-"));
    try {
      const { bundleDir } = await bundleEcho({ outDir: dir });
      const port = await freePort();
      // Test env: a dead facilitator (never reached - the gate 402s on the missing
      // X-PAYMENT header BEFORE any /verify call), dummy resource/cap/pricing.
      const child = spawn(process.execPath, [join(bundleDir, "server.js")], {
        env: {
          ...process.env,
          PORT: String(port),
          FACILITATOR_URL: "http://127.0.0.1:9",
          RESOURCE_ID: `0x${"11".repeat(32)}`,
          CAP: "1000000",
          PRICE_BASE: "1000",
          PRICE_PER_KB: "0",
          PRICE_MAX: "0",
        },
        stdio: "ignore",
      });
      try {
        const status = await pollUnpaidEcho(port, 15_000);
        expect(status).toBe(402);
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
