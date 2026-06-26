// bundle-generated.ts - the GENERATED (untrusted) bundle build core (deploy plane B).
//
// SECURITY: the bundle's handler.ts is UNTRUSTED generated code. We NEVER use the
// generated `npm ci` Dockerfile (generateDockerfile in build.ts); we reuse the proven
// echo esbuild path: esbuild a TRUSTED, platform-owned gate-less shim (which imports
// the generated ./handler) into ONE self-contained server.js behind the SAME no-install
// Dockerfile echo uses. The shim holds no facilitator config / no secret; the sidecar
// owns the money path. The pre-build static gate (gate-bundle.ts) MUST run BEFORE this
// over the in-memory bundle, so a malicious bundle is rejected before any artifact is
// produced.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { bundleNodeEntry, type BundleResult } from "./bundle-echo";

/**
 * The bundle file keys, as a POSIX-literal `as const` tuple. The VALUE is mirrored from
 * @utter/ai-runtime src/types.ts BUNDLE_KEYS; we re-declare it here rather than import
 * @utter/ai-runtime (importing it from the deployer is a dependency cycle). The keys are
 * kept POSIX-literal and used VERBATIM when writing files so a Windows backslash can
 * never enter a bundle key (T-k2f-04).
 */
export const GENERATED_BUNDLE_KEYS = [
  "handler.ts",
  "Dockerfile",
  "openapi.json",
  "agent-card.json",
  "test-cases.json",
] as const;

/** The trusted gate-less shim source, resolved relative to THIS module (cwd-agnostic). */
const SHIM_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "generated-server-shim.ts",
);

/** The deployer's node_modules, so esbuild resolves the shim's bare imports (hono). */
const DEPLOYER_NODE_MODULES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules",
);

/**
 * Write a generated bundle to a directory. For each key present in the bundle (and only
 * those in GENERATED_BUNDLE_KEYS), write the file at join(dir, key) using the POSIX key
 * VERBATIM (never path-normalize the key, so a Windows backslash cannot enter a key).
 * Throws a clear Error when handler.ts is missing or empty: handler.ts is required to
 * bundle (the shim imports it).
 */
export async function writeBundleToDir(
  bundle: Record<string, string>,
  dir: string,
): Promise<void> {
  const handler = bundle["handler.ts"];
  if (!handler || handler.trim().length === 0) {
    throw new Error("cannot bundle: handler.ts is missing or empty (it is required)");
  }

  const bundleDir = resolve(dir);
  await mkdir(bundleDir, { recursive: true });

  for (const key of GENERATED_BUNDLE_KEYS) {
    const value = bundle[key];
    if (value === undefined) continue;
    // Use the POSIX key VERBATIM (no normalize) so no backslash enters a key.
    await writeFile(join(bundleDir, key), value, "utf8");
  }
}

/**
 * Build a self-contained server.js from a GENERATED bundle that has ALREADY been written
 * to `bundleDir` (call writeBundleToDir first, so bundleDir/handler.ts is on disk). This
 * writes the TRUSTED gate-less shim into bundleDir (so its relative `./handler` resolves
 * to bundleDir/handler.ts), then esbuilds the shim as the entry with the SAME options as
 * the echo bundlers into bundleDir/server.js and writes the SAME no-install Dockerfile.
 * Returns the bundle dir + Dockerfile path.
 *
 * Ordering: handler.ts must be on disk (writeBundleToDir) BEFORE this runs so the shim's
 * `./handler` import resolves. The pre-build static gate (gateGeneratedBundle) MUST run
 * even earlier, over the in-memory bundle, before any file is written or esbuilt.
 */
export async function bundleGeneratedHandler(
  bundleDir: string,
  opts?: { port?: number },
): Promise<BundleResult> {
  const dir = resolve(bundleDir);

  // Write the trusted shim INTO the bundle dir as the esbuild entry, so its relative
  // `./handler` import resolves to the already-written generated bundleDir/handler.ts.
  const shimSource = await readFile(SHIM_SOURCE_PATH, "utf8");
  const shimEntry = join(dir, "generated-server-shim.ts");
  await writeFile(shimEntry, shimSource, "utf8");

  // Reuse the EXACT echo esbuild + no-install Dockerfile path. The shim entry lives in a
  // tmp dir, so pass the deployer node_modules for esbuild to resolve its bare imports.
  return bundleNodeEntry(shimEntry, {
    outDir: dir,
    port: opts?.port,
    nodePaths: [DEPLOYER_NODE_MODULES],
  });
}
