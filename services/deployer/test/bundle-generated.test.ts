// bundle-generated.test.ts - the GENERATED (untrusted) bundle build core (deploy
// plane B), no Docker / no host.
//
// Under test:
//   1. writeBundleToDir writes each present BUNDLE_KEYS file using the POSIX key
//      verbatim and throws when handler.ts is missing or empty.
//   2. bundleGeneratedHandler esbuilds the TRUSTED gate-less shim (which imports the
//      generated ./handler) into ONE self-contained server.js behind the SAME
//      no-install Dockerfile echo uses: server.js is non-trivial, has no leftover
//      @utter/* runtime require, references the generated handler success shape, and
//      the Dockerfile has CMD ["node","server.js"] with no npm ci install step.
import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeBundleToDir,
  bundleGeneratedHandler,
  GENERATED_BUNDLE_KEYS,
} from "../src/bundle-generated";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read the benign generated-handler fixture source (source-only, never executed). */
function benignHandlerSource(): string {
  return readFileSync(resolve(HERE, "fixtures/generated-benign/handler.ts"), "utf8");
}

/** A minimal benign generated bundle object (handler.ts + tiny declarative files). */
function benignBundle(): Record<string, string> {
  return {
    "handler.ts": benignHandlerSource(),
    "openapi.json": JSON.stringify({ openapi: "3.1.0", paths: {} }),
    "agent-card.json": JSON.stringify({ name: "benign", version: "1.0.0" }),
    "test-cases.json": JSON.stringify([{ name: "ok", input: { text: "hi" } }]),
  };
}

describe("GENERATED_BUNDLE_KEYS (POSIX literal, mirrored from ai-runtime)", () => {
  it("matches the ai-runtime BUNDLE_KEYS value with no backslash in any key", () => {
    expect(GENERATED_BUNDLE_KEYS).toEqual([
      "handler.ts",
      "Dockerfile",
      "openapi.json",
      "agent-card.json",
      "test-cases.json",
    ]);
    for (const k of GENERATED_BUNDLE_KEYS) {
      expect(k).not.toContain("\\");
    }
  });
});

describe("writeBundleToDir (POSIX keys verbatim; requires handler.ts)", () => {
  it("writes each present key file using the POSIX key verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-gen-write-"));
    try {
      await writeBundleToDir(benignBundle(), dir);
      // Each declared key was written at join(dir, key) (POSIX key verbatim).
      await stat(join(dir, "handler.ts"));
      await stat(join(dir, "openapi.json"));
      await stat(join(dir, "agent-card.json"));
      await stat(join(dir, "test-cases.json"));
      const handler = await readFile(join(dir, "handler.ts"), "utf8");
      expect(handler).toContain("export async function handler");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when handler.ts is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-gen-nohandler-"));
    try {
      const noHandler = { "openapi.json": "{}" };
      await expect(writeBundleToDir(noHandler, dir)).rejects.toThrow(/handler\.ts/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when handler.ts is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-gen-emptyhandler-"));
    try {
      const emptyHandler = { "handler.ts": "" };
      await expect(writeBundleToDir(emptyHandler, dir)).rejects.toThrow(/handler\.ts/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bundleGeneratedHandler (trusted shim + esbuild + no-install Dockerfile)", () => {
  it("produces a self-contained server.js referencing the generated handler, no @utter requires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "utter-gen-bundle-"));
    try {
      await writeBundleToDir(benignBundle(), dir);
      const { bundleDir, dockerfilePath } = await bundleGeneratedHandler(dir);
      expect(bundleDir).toBe(resolve(dir));

      const serverJs = await readFile(join(bundleDir, "server.js"), "utf8");
      // Non-trivial: hono + the generated handler are inlined.
      expect(serverJs.length).toBeGreaterThan(5_000);
      // The generated handler is inlined, not required at runtime.
      expect(serverJs).not.toMatch(/require\(["']@utter\//);
      expect(serverJs).not.toMatch(/from\s+["']@utter\//);
      // The generated handler's success shape is inlined (it references `length`).
      expect(serverJs).toContain("length");
      // The src type-stub handler is NOT bundled: the generated handler shadows it.
      expect(serverJs).not.toContain("NOT_BUNDLED");

      const dockerfile = await readFile(dockerfilePath, "utf8");
      expect(dockerfile).toContain('CMD ["node", "server.js"]');
      // No install step: the bundle is self-contained.
      expect(dockerfile).not.toContain("npm ci");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
