// orchestrate.ts - the REAL deploy orchestrator (host phase H2).
//
// This is the genuine launch plane for a deployed resource: it builds the resource
// image, runs it as a hardened gVisor service on the named internal app network,
// and atomically writes the per-resource Traefik route file the file provider
// hot-loads. live-deploy.ts drives these one-shot for the first live 402->200
// proof; the FOLLOW-ON reconcile increment (H3) adapts launchEchoContainer /
// reapEchoContainer to the reconcile loop's launchContainer / reapContainer hook
// seams (they are call-compatible in shape, not wired here).
//
// SECURITY: every container goes through buildResourceServiceSpec, which keeps the
// full one-shot isolation posture (runsc, readonly root, capDrop ALL,
// no-new-privileges, pids/mem/cpu caps) and admits ONLY the secret-guarded
// non-secret env allowlist. The orchestrator reads NO key and logs NO secret - it
// only ever logs an image tag, a container name, a written path, and amounts.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import Docker from "dockerode";
import type { Hex } from "viem";
import type { Pricing } from "@utter/x402-arc";
import {
  GvisorRunner,
  buildResourceServiceSpec,
  type ServiceHandle,
  type RunLimits,
} from "@utter/sandbox";
import { bundleEcho } from "./bundle-echo";
import { buildResourceImage } from "./build";
import {
  buildTraefikDynamicConfig,
  validateSlug,
} from "./traefik-config";

/**
 * A minimal docker handle the orchestrator needs (the GvisorRunner constructor and
 * the build path both accept a dockerode instance). Kept structural so the host gate
 * can hand a real dockerode in and a test can hand a spy in without a live daemon.
 * This is the canonical home of the type; live-deploy re-exports it for back-compat.
 */
export type DockerHandle = ConstructorParameters<typeof GvisorRunner>[0];

/**
 * Resolve a real dockerode handle on the provisioned host, or `undefined` when no
 * docker daemon should be touched. It is intentionally gated on
 * UTTER_SANDBOX_HOST=1: a dev box (no runsc, no app network) must never accidentally
 * construct one. dockerode is already a deployer dependency (the build path uses it),
 * so no new import lands. This REPLACES the always-undefined stub that lived in
 * live-deploy.ts.
 */
export function resolveDockerHandle(): DockerHandle | undefined {
  if (process.env.UTTER_SANDBOX_HOST !== "1") {
    return undefined;
  }
  // dockerode's default constructor reads the conventional docker socket. The
  // narrow structural DockerHandle type satisfies both GvisorRunner and
  // buildResourceImage at runtime.
  return new Docker() as unknown as DockerHandle;
}

/**
 * The stable identity + isolation caps for the deployed echo service. The container
 * NAME is the Traefik backend target on the app network (NOT the slug): Traefik
 * resolves the service container by its name over the user-defined bridge. The
 * limits are resource caps (pids/mem/cpu), not money or scale literals.
 */
export const ECHO_SERVICE = {
  /** The stable container name (matches SERVICE_NAME_PATTERN ^utter_res_[a-z0-9-]+$). */
  name: "utter_res_echo",
  /** The named internal app network the H1 compose stack puts the facilitator on. */
  network: "utter_appnet",
  /** The container listen port (matches main.ts PORT default + the bundle EXPOSE). */
  port: 8080,
  /** The Traefik loadBalancer target = the container NAME on appnet, port 8080. */
  containerUrl: "http://utter_res_echo:8080",
  /** Resource caps for the long-lived echo (not money/scale literals). */
  limits: {
    pidsLimit: 256,
    memoryBytes: 256 * 1024 * 1024,
    cpus: 0.5,
  } satisfies RunLimits,
} as const;

/** The default echo image tag the build produces + the runner launches. */
export const ECHO_IMAGE_TAG = "utter-resource-echo:latest";

/** Options for {@link resolveFacilitatorUrl}. */
export interface ResolveFacilitatorUrlOpts {
  /** The network to inspect for the facilitator container (default ECHO_SERVICE.network). */
  network?: string;
  /** The facilitator listen port (default 8787). */
  port?: number;
  /** The substring (case-insensitive) that marks the facilitator container's Name (default "facilitator"). */
  containerNameHint?: string;
}

/**
 * Resolve the facilitator's reachable URL by its on-network IP, NOT its DNS name.
 *
 * WHY: a deployed resource runs under runsc/gVisor, whose sandboxed network stack
 * cannot use Docker's embedded DNS resolver at 127.0.0.11. A resource container that
 * POSTs to the facilitator by the service name `facilitator` gets EAI_AGAIN (the
 * name never resolves). So we inspect the app network here, read the facilitator
 * container's IPv4 address, and hand the resource the literal `http://<ip>:<port>`.
 * An explicit FACILITATOR_URL env still wins at the call site (live-deploy.ts).
 *
 * Future improvement (durable, production): pin the facilitator to a static IP on
 * the app network or inject an ExtraHosts mapping into the resource container so the
 * name resolves without an inspect step. For the first live proof the inspect is the
 * smallest no-manual-step fix.
 *
 * @throws if no container whose Name contains the hint is attached to the network
 *         (the operator must bring the platform stack up first).
 */
export async function resolveFacilitatorUrl(
  docker: DockerHandle,
  opts: ResolveFacilitatorUrlOpts = {},
): Promise<string> {
  const network = opts.network ?? ECHO_SERVICE.network;
  const port = opts.port ?? 8787;
  const hint = (opts.containerNameHint ?? "facilitator").toLowerCase();

  const dockerApi = docker as unknown as Docker;
  const info = await dockerApi.getNetwork(network).inspect();
  const containers = info.Containers ?? {};

  for (const entry of Object.values(containers)) {
    if (!entry?.Name?.toLowerCase().includes(hint)) continue;
    // IPv4Address carries a `/CIDR` suffix (e.g. "172.20.0.5/16"); strip it.
    const ip = (entry.IPv4Address ?? "").split("/")[0]?.trim();
    if (!ip) continue;
    return `http://${ip}:${port}`;
  }

  throw new Error(
    `resolveFacilitatorUrl: no container matching "${hint}" found on network "${network}". ` +
      "Bring the platform stack up first (docker compose ... up -d), then re-run. See infrastructure/RUNBOOK.md.",
  );
}

/** Inputs to {@link buildEchoServiceEnv}. */
export interface BuildEchoServiceEnvOpts {
  /** The facilitator base URL the echo's gate POSTs verify/settle/release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32 Hex) - the escrow payTo. */
  resourceId: Hex;
  /** The signed spend cap advertised in the 402 quote (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** The container listen port. */
  port: number;
}

/**
 * Assemble the RAW non-secret env the echo container reads (main.ts:
 * FACILITATOR_URL, RESOURCE_ID, PORT, CAP, MAX_TIMEOUT_SECONDS, PRICE_BASE,
 * PRICE_PER_KB, PRICE_MAX). Pricing maps PRICE_BASE<-base, PRICE_PER_KB<-perKB,
 * PRICE_MAX<-computeMultiplier (main.ts's documented mapping). Keeping the mapping
 * here puts it in one unit-testable place; buildResourceServiceSpec then runs
 * buildServiceEnv over the result to allowlist + secret-guard every key.
 */
export function buildEchoServiceEnv(opts: BuildEchoServiceEnvOpts): Record<string, string> {
  return {
    FACILITATOR_URL: opts.facilitatorUrl,
    RESOURCE_ID: opts.resourceId,
    PORT: String(opts.port),
    CAP: opts.cap.toString(),
    MAX_TIMEOUT_SECONDS: String(opts.maxTimeoutSeconds),
    PRICE_BASE: opts.pricing.base,
    PRICE_PER_KB: opts.pricing.perKB,
    PRICE_MAX: opts.pricing.computeMultiplier,
  };
}

/**
 * The default Traefik dynamic-config dir, resolved relative to THIS module (NOT
 * cwd: live-deploy runs from services/deployer, so cwd would point at the wrong
 * tree). src/orchestrate.ts -> ../../../infrastructure/traefik/dynamic.
 */
function defaultDynamicDir(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../infrastructure/traefik/dynamic",
  );
}

/** Inputs to {@link writeTraefikDynamicFile}. */
export interface WriteTraefikDynamicFileOpts {
  /** The resource slug -> the router/service key + the `<slug>.resources.<domain>` host. */
  slug: string;
  /** The deploy domain (the apex is `resources.<domain>`). */
  domain: string;
  /** The container URL the loadBalancer points at (the container name on appnet). */
  containerUrl: string;
  /** Override the dynamic dir (tests pass a tmp dir); defaults to the repo dir. */
  dynamicDir?: string;
}

/**
 * Build the per-resource Traefik dynamic config and write it ATOMICALLY to
 * `<dynamicDir>/<slug>.yml`. The atomic write (write `<file>.tmp` then rename)
 * guarantees the file provider never reads a half-written document mid-hot-load.
 * Returns the written path. validateSlug at entry so a bad slug can never mint a
 * path-traversing filename or a colliding router key.
 */
export async function writeTraefikDynamicFile(
  opts: WriteTraefikDynamicFileOpts,
): Promise<string> {
  const slug = validateSlug(opts.slug);
  const dir = opts.dynamicDir ?? defaultDynamicDir();
  await mkdir(dir, { recursive: true });

  const { yaml } = buildTraefikDynamicConfig({
    slug,
    domain: opts.domain,
    containerUrl: opts.containerUrl,
  });

  const filePath = join(dir, `${slug}.yml`);
  const tmpPath = `${filePath}.tmp`;
  // Atomic publish: write the temp file fully, then rename over the target so the
  // file provider only ever observes a complete document.
  await writeFile(tmpPath, yaml, "utf8");
  await rename(tmpPath, filePath);
  return filePath;
}

/**
 * Best-effort remove a per-resource Traefik dynamic file (for reap / redeploy). A
 * missing file is a no-op (ENOENT swallowed). validateSlug at entry.
 */
export async function removeTraefikDynamicFile(
  slug: string,
  dynamicDir?: string,
): Promise<void> {
  const validated = validateSlug(slug);
  const dir = dynamicDir ?? defaultDynamicDir();
  const filePath = join(dir, `${validated}.yml`);
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Inputs to {@link launchEchoContainer}. */
export interface LaunchEchoContainerOpts {
  /** The facilitator base URL the echo's gate POSTs verify/settle/release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32 Hex). */
  resourceId: Hex;
  /** The signed spend cap (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing terms. */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** Override the image tag (defaults to ECHO_IMAGE_TAG). */
  tag?: string;
}

/** The result of a launch: the live service handle + the image tag it runs. */
export interface LaunchEchoContainerResult {
  /** The handle to the launched long-lived service (stop() to tear down). */
  handle: ServiceHandle;
  /** The image tag that was built + launched. */
  imageTag: string;
}

/**
 * The REAL launch path: bundle the echo, build its image, then run it as a
 * hardened runsc service on the app network. This is the implementation H3 will
 * adapt to the reconcile loop's launchContainer hook. It needs a LIVE docker
 * daemon + runsc, so it is NEVER called from an autonomous test (the pure pieces -
 * buildEchoServiceEnv, the Traefik writers - are tested instead).
 *
 * @throws if the build did not actually run (a docker handle was given, so the
 *         image MUST build) or buildResourceServiceSpec rejects the env/spec.
 */
export async function launchEchoContainer(
  docker: DockerHandle,
  opts: LaunchEchoContainerOpts,
): Promise<LaunchEchoContainerResult> {
  const tag = opts.tag ?? ECHO_IMAGE_TAG;

  // (1) Bundle the echo into a self-contained server.js + prebundled Dockerfile in
  // a stable tmp dir (reused across redeploys).
  const { bundleDir } = await bundleEcho({
    outDir: join(tmpdir(), "utter-echo-bundle"),
    port: ECHO_SERVICE.port,
  });

  // (2) Build the image. A docker handle was provided, so the build MUST run; if it
  // does not we cannot serve the echo, so fail loud rather than curling a dead URL.
  const build = await buildResourceImage(bundleDir, {
    runtime: "node",
    tag,
    docker: docker as unknown as Docker,
  });
  if (!build.built) {
    throw new Error(
      `launchEchoContainer: image '${tag}' was not built (a docker handle was provided, ` +
        "so it must build). Confirm DEPLOY_BASE_IMAGE_NODE is a real digest-pinned base on the host.",
    );
  }

  // (3) Idempotency: best-effort remove any prior container with the same name so a
  // redeploy does not collide on the stable service name. not-found is swallowed.
  const dockerApi = docker as unknown as Docker;
  try {
    await dockerApi.getContainer(ECHO_SERVICE.name).remove({ force: true });
  } catch {
    // No prior container (or already gone): nothing to clean up.
  }

  // (4) Launch the hardened runsc service. buildResourceServiceSpec keeps the full
  // isolation posture and runs buildServiceEnv over the assembled env (allowlist +
  // secret guard); a rejected key throws here, before any container starts.
  const spec = buildResourceServiceSpec({
    backend: "gvisor",
    image: tag,
    limits: ECHO_SERVICE.limits,
    network: ECHO_SERVICE.network,
    env: buildEchoServiceEnv({
      facilitatorUrl: opts.facilitatorUrl,
      resourceId: opts.resourceId,
      cap: opts.cap,
      pricing: opts.pricing,
      maxTimeoutSeconds: opts.maxTimeoutSeconds,
      port: ECHO_SERVICE.port,
    }),
    name: ECHO_SERVICE.name,
    port: ECHO_SERVICE.port,
  });

  const handle = await new GvisorRunner(docker).startService(spec);
  return { handle, imageTag: tag };
}

/**
 * Stop + remove the named echo service container (force) and remove its Traefik
 * route file. Best-effort: a missing container or file is a no-op. For redeploy /
 * teardown and the future reaper hook (H3).
 */
export async function reapEchoContainer(
  docker: DockerHandle,
  name: string = ECHO_SERVICE.name,
): Promise<void> {
  const dockerApi = docker as unknown as Docker;
  try {
    await dockerApi.getContainer(name).remove({ force: true });
  } catch {
    // Already gone: nothing to remove.
  }
  // Drop the route so Traefik stops advertising a backend that no longer exists.
  await removeTraefikDynamicFile("echo");
}

/** Options for {@link waitForUnpaid402}. */
export interface WaitForUnpaid402Opts {
  /** Total time to wait for a 402 before giving up (ms). */
  timeoutMs?: number;
  /** Poll interval between attempts (ms). */
  intervalMs?: number;
}

/**
 * Poll a deployed resource URL with the same unpaid POST until it returns 402,
 * tolerating the transient states of a fresh deploy: a fetch throw (TLS not yet
 * ready / DNS still propagating), a 404 / 502 while the container boots, and the
 * first-time ACME wildcard-cert issuance latency. Returns the 402 Response once the
 * paywall is live; throws a clear timeout error if 402 never arrives.
 *
 * It deliberately does NOT treat a non-402, non-transient status as success: only
 * a real 402 (the advertised accepts quote) resolves the wait.
 */
export async function waitForUnpaid402(
  url: string,
  fetchImpl: typeof fetch,
  opts: WaitForUnpaid402Opts = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  // The same unpaid POST the live deploy sends (no X-PAYMENT -> expect the quote).
  const reqInit = {
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify({ text: "live" }),
  };

  let lastStatus: number | undefined;
  let lastError: string | undefined;
  for (;;) {
    try {
      const res = await fetchImpl(url, reqInit);
      if (res.status === 402) return res;
      lastStatus = res.status;
    } catch (err) {
      // A boot-window fetch failure (TLS/DNS/cert not ready) is expected; retry.
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (Date.now() >= deadline) {
      const detail = lastStatus !== undefined ? `last status ${lastStatus}` : `last error: ${lastError ?? "none"}`;
      throw new Error(
        `waitForUnpaid402: ${url} never returned 402 within ${timeoutMs}ms (${detail}). ` +
          "Check the container booted on utter_appnet, the Traefik route was written, and the wildcard cert issued.",
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
