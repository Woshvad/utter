// bundle-echo.ts - bundle a node workspace entrypoint into a single self-contained
// server.js plus a prebundled Dockerfile (deploy plane B).
//
// The deployed artifacts are workspace TS that import @utter/x402-arc (the echo, the
// gate-less handler, the sidecar gate-server), so a generated `npm ci` Dockerfile
// could never resolve them. Instead we esbuild each entrypoint into ONE self-contained
// CJS server.js with viem, hono, the gate, the handler, and any openapi.json all
// inlined - so the image needs NO install (which also makes the no-network-at-build
// property automatic) and `node server.js` runs with zero external deps.
//
// This module produces the standalone artifacts only. It does NOT touch the shared
// generateDockerfile (the ai-runtime npm-ci path is a later increment). The dir each
// bundler produces is exactly what buildResourceImage streams to dockerode, whose
// {dockerfile:"Dockerfile"} reads the prebundled Dockerfile FROM the context as-is.
//
// Wave BC1 generalizes the original echo-only bundler into a shared node-bundle helper
// and adds two new artifacts for the sidecar topology: bundleEchoHandler (the gate-less
// handler image) and bundleSidecar (the trusted gate-server image). bundleEcho is
// unchanged for the Phase 1 single-container path.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { resolveBaseImage, assertPinnedByDigest } from "./build";

/** The default port a bundled node service listens on (matches the entrypoints' PORT default). */
const DEFAULT_BUNDLE_PORT = 8080;

/** The x402-arc examples dir, resolved relative to THIS module (cwd-agnostic). */
const EXAMPLES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/x402-arc/examples",
);

/** The in-process echo container entrypoint (Phase 1 single-container, gate inside). */
const ECHO_MAIN_ENTRY = join(EXAMPLES_DIR, "echo/main.ts");

/** The GATE-LESS echo handler entrypoint (sidecar topology, no gate, no facilitator). */
const ECHO_HANDLER_ENTRY = join(EXAMPLES_DIR, "echo/handler-main.ts");

/** The standalone SIDECAR gate-server entrypoint (trusted, reverse-proxies the handler). */
const SIDECAR_MAIN_ENTRY = join(EXAMPLES_DIR, "sidecar/main.ts");

/** Common options for the node-entry bundlers. */
export interface BundleOpts {
  /** The directory to write server.js + Dockerfile into (created if absent). */
  outDir: string;
  /** The port the container EXPOSEs and the server listens on (default 8080). */
  port?: number;
}

/** Back-compat alias: the original echo bundler option name. */
export type BundleEchoOpts = BundleOpts;

/** The result of a bundle: the dir + the written Dockerfile path. */
export interface BundleResult {
  /** The directory holding the self-contained server.js + Dockerfile. */
  bundleDir: string;
  /** The absolute path to the prebundled Dockerfile. */
  dockerfilePath: string;
}

/** Back-compat alias: the original echo bundler result name. */
export type BundleEchoResult = BundleResult;

/**
 * Build the prebundled Dockerfile for a node bundle: FROM the resolved (env-
 * overridable, digest-pinned) node base, copy the single server.js, drop to the
 * non-root node user, expose the port, and run `node server.js`. No install step -
 * the bundle is self-contained, so there is nothing to install. This is the shared
 * body for every node-entry artifact (echo, the gate-less handler, the sidecar).
 */
export function buildNodeBundleDockerfile(port: number): string {
  const baseImage = resolveBaseImage("node");
  // Assert the resolved base is pinned BY DIGEST so a bad env override fails loud.
  assertPinnedByDigest(baseImage);
  return [
    "# prebundled image: a single self-contained server.js, no install step",
    `FROM ${baseImage}`,
    "WORKDIR /app",
    "COPY server.js ./",
    "USER node",
    `EXPOSE ${port}`,
    'CMD ["node", "server.js"]',
    "",
  ].join("\n");
}

/**
 * Back-compat wrapper for the original echo Dockerfile builder. Identical output to
 * {@link buildNodeBundleDockerfile}; kept so existing import sites do not break.
 */
export function buildEchoDockerfile(port: number): string {
  return buildNodeBundleDockerfile(port);
}

/**
 * Bundle a single workspace node entrypoint into `<outDir>/server.js` (one
 * self-contained CJS file: viem/hono/gate/handler/openapi.json all inlined) and write
 * the prebundled `<outDir>/Dockerfile`. Returns the dir + Dockerfile path. The shared
 * internal core every public bundler (echo, handler, sidecar) routes through - only
 * the entry file differs.
 */
async function bundleNodeEntry(entry: string, opts: BundleOpts): Promise<BundleResult> {
  const port = opts.port ?? DEFAULT_BUNDLE_PORT;
  const bundleDir = resolve(opts.outDir);
  await mkdir(bundleDir, { recursive: true });

  const serverPath = join(bundleDir, "server.js");
  // Bundle to ONE self-contained CJS file targeting node22, so `node server.js`
  // runs with no external deps (any JSON import inlines too).
  await build({
    entryPoints: [entry],
    outfile: serverPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  });

  const dockerfilePath = join(bundleDir, "Dockerfile");
  await writeFile(dockerfilePath, buildNodeBundleDockerfile(port), "utf8");

  return { bundleDir, dockerfilePath };
}

/**
 * Bundle the IN-PROCESS echo resource (examples/echo/main.ts: the trusted handler
 * behind the gate, the Phase 1 single-container path) into a self-contained server.js
 * + prebundled Dockerfile. Unchanged behavior from the original echo-only bundler.
 */
export async function bundleEcho(opts: BundleEchoOpts): Promise<BundleResult> {
  return bundleNodeEntry(ECHO_MAIN_ENTRY, opts);
}

/**
 * Bundle the GATE-LESS echo handler (examples/echo/handler-main.ts: the untrusted
 * handler container in the sidecar topology, NO gate, NO facilitator config) into a
 * self-contained server.js + prebundled Dockerfile. Wave BC2 launches this paired
 * with the sidecar image.
 */
export async function bundleEchoHandler(opts: BundleOpts): Promise<BundleResult> {
  return bundleNodeEntry(ECHO_HANDLER_ENTRY, opts);
}

/**
 * Bundle the standalone SIDECAR gate-server (examples/sidecar/main.ts: the trusted
 * container running the UNCHANGED requirePayment gate, reverse-proxying to the
 * gate-less handler at HANDLER_URL) into a self-contained server.js + prebundled
 * Dockerfile. hono + the gate + @utter/chain are all inlined, so the sidecar image
 * needs no install - same self-contained property as the echo bundle.
 */
export async function bundleSidecar(opts: BundleOpts): Promise<BundleResult> {
  return bundleNodeEntry(SIDECAR_MAIN_ENTRY, opts);
}
