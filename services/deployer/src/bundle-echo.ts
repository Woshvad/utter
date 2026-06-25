// bundle-echo.ts - bundle the echo resource into a single self-contained server.js
// plus a prebundled Dockerfile (deploy plane B).
//
// The echo is workspace TS that imports @utter/x402-arc, so a generated `npm ci`
// Dockerfile could never resolve it. Instead we esbuild the echo entrypoint
// (examples/echo/main.ts) into ONE self-contained CJS server.js with viem, hono,
// the gate, the handler, and the openapi.json all inlined - so the image needs NO
// install (which also makes the no-network-at-build property automatic) and
// `node server.js` runs with zero external deps.
//
// This is the ECHO standalone artifact only. It does NOT touch the shared
// generateDockerfile (the ai-runtime npm-ci path is a later increment). The dir this
// produces is exactly what buildResourceImage streams to dockerode, whose
// {dockerfile:"Dockerfile"} reads the prebundled Dockerfile FROM the context as-is.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { resolveBaseImage, assertPinnedByDigest } from "./build";

/** The default port the deployed echo listens on (matches main.ts PORT default). */
const DEFAULT_ECHO_PORT = 8080;

/** The echo container entrypoint, resolved relative to THIS module (cwd-agnostic). */
const ECHO_MAIN_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/x402-arc/examples/echo/main.ts",
);

/** Options for {@link bundleEcho}. */
export interface BundleEchoOpts {
  /** The directory to write server.js + Dockerfile into (created if absent). */
  outDir: string;
  /** The port the container EXPOSEs and the server listens on (default 8080). */
  port?: number;
}

/** The result of a bundle: the dir + the written Dockerfile path. */
export interface BundleEchoResult {
  /** The directory holding the self-contained server.js + Dockerfile. */
  bundleDir: string;
  /** The absolute path to the prebundled Dockerfile. */
  dockerfilePath: string;
}

/**
 * Build the prebundled Dockerfile for the echo bundle: FROM the resolved (env-
 * overridable, digest-pinned) node base, copy the single server.js, drop to the
 * non-root node user, expose the port, and run `node server.js`. No install step -
 * the bundle is self-contained, so there is nothing to install.
 */
export function buildEchoDockerfile(port: number): string {
  const baseImage = resolveBaseImage("node");
  // Assert the resolved base is pinned BY DIGEST so a bad env override fails loud.
  assertPinnedByDigest(baseImage);
  return [
    "# prebundled echo image: a single self-contained server.js, no install step",
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
 * Bundle the echo resource into `<outDir>/server.js` (a single self-contained CJS
 * file: viem/hono/gate/handler/openapi.json all inlined) and write a prebundled
 * `<outDir>/Dockerfile`. Returns the dir + Dockerfile path. The dir is what
 * buildResourceImage(bundleDir, {runtime:'node', ...}) streams to dockerode; the
 * prebundled Dockerfile is used as-is.
 */
export async function bundleEcho(opts: BundleEchoOpts): Promise<BundleEchoResult> {
  const port = opts.port ?? DEFAULT_ECHO_PORT;
  const bundleDir = resolve(opts.outDir);
  await mkdir(bundleDir, { recursive: true });

  const serverPath = join(bundleDir, "server.js");
  // Bundle to ONE self-contained CJS file targeting node22, so `node server.js`
  // runs with no external deps (the JSON import inlines too).
  await build({
    entryPoints: [ECHO_MAIN_ENTRY],
    outfile: serverPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  });

  const dockerfilePath = join(bundleDir, "Dockerfile");
  await writeFile(dockerfilePath, buildEchoDockerfile(port), "utf8");

  return { bundleDir, dockerfilePath };
}
