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
  buildTrustedServiceSpec,
  type ServiceHandle,
  type RunLimits,
} from "@utter/sandbox";
import { bundleEcho, bundleEchoHandler, bundleSidecar } from "./bundle-echo";
import { buildResourceImage } from "./build";
import {
  buildTraefikDynamicConfig,
  validateSlug,
} from "./traefik-config";
import type { ActualContainer } from "./reconcile";

/**
 * The Docker label key carrying a managed container's resourceId. The reconcile
 * loop filters containers by this label to find the ones IT manages, and reads the
 * value back as the resourceId. Non-secret operator metadata.
 */
export const RESOURCE_ID_LABEL = "io.utter.resource-id";

/**
 * The Docker label key carrying a managed container's resource slug. The reaper
 * reads it to drop the matching Traefik dynamic file. Non-secret operator metadata.
 */
export const SLUG_LABEL = "io.utter.slug";

/**
 * The Docker label key carrying a managed container's ROLE in the sidecar topology:
 * "handler" (the untrusted gate-less container) or "gate" (the trusted sidecar). The
 * reaper lists by slug and removes every role; this label lets an operator tell the
 * two apart. Non-secret operator metadata.
 */
export const ROLE_LABEL = "io.utter.role";

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

// ---------------------------------------------------------------------------
// Sidecar topology (Security review C1, wave BC2b): the two-container PAIR.
//
// A deployed resource is now an UNTRUSTED gate-less HANDLER container plus a
// TRUSTED SIDECAR gate container. The handler holds NO facilitator route and NO
// caller-auth token (it can never reach the facilitator, forge a strike, or
// self-settle); the sidecar (only) reaches the facilitator and reverse-proxies
// validated calls to the handler by the handler's inspected IP. Traefik routes to
// the SIDECAR. The legacy single-container ECHO_SERVICE path above is kept intact.
// ---------------------------------------------------------------------------

/** The role label value for the untrusted gate-less handler container. */
export const ROLE_HANDLER = "handler";
/** The role label value for the trusted sidecar gate container. */
export const ROLE_GATE = "gate";

/** The named networks the pair joins (env-overridable; default the BD six-net names).
 *
 * The handler joins ONLY proxynet (it talks to nothing but the sidecar's proxy hop);
 * the sidecar's primary is ingress (Traefik reaches it there) plus controlplane (the
 * facilitator) and proxynet (the handler). These default names require wave BD's
 * six-network compose on the host before the live path can run. */
export const PAIR_NETWORKS = {
  /** The handler's only network (the sidecar reaches it here by IP). */
  handler: process.env.HANDLER_NETWORK?.trim() || "proxynet",
  /** The sidecar's PRIMARY network (Traefik routes to it here). */
  sidecar: process.env.SIDECAR_NETWORK?.trim() || "ingress",
  /** The sidecar's EXTRA networks (controlplane for the facilitator, proxynet for the handler). */
  sidecarExtras: (process.env.SIDECAR_EXTRA_NETWORKS?.trim()
    ? process.env.SIDECAR_EXTRA_NETWORKS.split(",").map((n) => n.trim()).filter((n) => n.length > 0)
    : ["controlplane", "proxynet"]),
} as const;

/** The container listen port both pair containers EXPOSE + serve on (matches the bundles). */
export const PAIR_PORT = 8080;

/**
 * Derive the pair's container names from a slug: `utter_res_<slug>-handler` and
 * `utter_res_<slug>-gate`. Both match SERVICE_NAME_PATTERN (`^utter_res_[a-z0-9-]+$`)
 * because the slug is validated `[a-z0-9-]` and the suffixes keep it dns-safe.
 */
export function pairNames(slug: string): { handlerName: string; sidecarName: string } {
  const validated = validateSlug(slug);
  return {
    handlerName: `utter_res_${validated}-${ROLE_HANDLER}`,
    sidecarName: `utter_res_${validated}-${ROLE_GATE}`,
  };
}

/**
 * The Traefik loadBalancer target for the pair: the SIDECAR container name on the
 * sidecar network, port 8080. Traefik runs under runc so Docker DNS resolves the
 * sidecar by name (only the runsc resource/sidecar containers cannot use DNS). The
 * route points at the gate, NOT the handler.
 */
export function sidecarContainerUrl(slug: string): string {
  return `http://${pairNames(slug).sidecarName}:${PAIR_PORT}`;
}

/** Inputs to {@link buildHandlerServiceEnv}. */
export interface BuildHandlerServiceEnvOpts {
  /** The resource being served (bytes32 Hex) - the card's payTo. */
  resourceId: Hex;
  /** The signed spend cap advertised in the card (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing advertised in the card. */
  pricing: Pricing;
  /** Max handler runtime the card advertises (seconds). */
  maxTimeoutSeconds: number;
  /** The container listen port. */
  port: number;
}

/**
 * Assemble the GATE-LESS handler container env (handler-main.ts loadHandlerConfig:
 * RESOURCE_ID, CAP, MAX_TIMEOUT_SECONDS, PRICE_BASE/PRICE_PER_KB/PRICE_MAX, PORT).
 *
 * It carries NO FACILITATOR_URL and NO caller-auth token - the untrusted handler must
 * never see facilitator config or a secret (the sidecar owns the whole payment dance).
 * Every key here is a SERVICE_ENV_ALLOWLIST member, so the env round-trips cleanly
 * through buildResourceServiceSpec's secret guard.
 */
export function buildHandlerServiceEnv(opts: BuildHandlerServiceEnvOpts): Record<string, string> {
  return {
    RESOURCE_ID: opts.resourceId,
    PORT: String(opts.port),
    CAP: opts.cap.toString(),
    MAX_TIMEOUT_SECONDS: String(opts.maxTimeoutSeconds),
    PRICE_BASE: opts.pricing.base,
    PRICE_PER_KB: opts.pricing.perKB,
    PRICE_MAX: opts.pricing.computeMultiplier,
  };
}

/** Inputs to {@link buildSidecarServiceEnv}. */
export interface BuildSidecarServiceEnvOpts {
  /** The facilitator base URL the sidecar gate POSTs verify/settle/release to. */
  facilitatorUrl: string;
  /** The resource being charged (bytes32 Hex) - the escrow payTo. */
  resourceId: Hex;
  /** The signed spend cap advertised in the 402 quote (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing (the escrow charge formula terms). */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** Where the gate-less handler container listens (the inspected IP:port). */
  handlerUrl: string;
  /** The per-resource caller-auth token the gate presents to the facilitator. NEVER logged. */
  facilitatorToken: string;
  /** The JSON response schema the gate classifies against (declared-errors stay free). */
  classifierSchema: string;
  /** The container listen port. */
  port: number;
}

/**
 * Assemble the TRUSTED sidecar container env (sidecar.ts loadSidecarConfig:
 * FACILITATOR_URL, RESOURCE_ID, CAP, MAX_TIMEOUT_SECONDS, PRICE_*, HANDLER_URL,
 * SIDECAR_FACILITATOR_TOKEN, CLASSIFIER_SCHEMA, PORT).
 *
 * This env carries the facilitator route + the caller-auth token + the classifier
 * schema, so it MUST go through buildTrustedServiceSpec (which does NOT run the secret
 * guard); buildResourceServiceSpec would reject the token. NEVER logs the token.
 */
export function buildSidecarServiceEnv(opts: BuildSidecarServiceEnvOpts): Record<string, string> {
  return {
    FACILITATOR_URL: opts.facilitatorUrl,
    RESOURCE_ID: opts.resourceId,
    PORT: String(opts.port),
    CAP: opts.cap.toString(),
    MAX_TIMEOUT_SECONDS: String(opts.maxTimeoutSeconds),
    PRICE_BASE: opts.pricing.base,
    PRICE_PER_KB: opts.pricing.perKB,
    PRICE_MAX: opts.pricing.computeMultiplier,
    HANDLER_URL: opts.handlerUrl,
    SIDECAR_FACILITATOR_TOKEN: opts.facilitatorToken,
    CLASSIFIER_SCHEMA: opts.classifierSchema,
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
    // Stamp the non-secret resourceId + slug labels so the reconcile loop can read
    // this managed container back (listResourceContainers / reapResourceContainer).
    labels: {
      [RESOURCE_ID_LABEL]: opts.resourceId,
      [SLUG_LABEL]: "echo",
    },
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

/** Inputs to {@link launchResourcePair}. */
export interface LaunchResourcePairOpts {
  /** The resource being charged (bytes32 Hex) - the escrow payTo + the card payTo. */
  resourceId: Hex;
  /** The resource slug; derives both container names + the Traefik route key. */
  slug: string;
  /** The signed spend cap (USDC base units). */
  cap: bigint;
  /** The per-resource metered pricing terms. */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** The facilitator base URL the SIDECAR (only) POSTs verify/settle/release to. */
  facilitatorUrl: string;
  /** The per-resource caller-auth token the SIDECAR presents to the facilitator. NEVER logged. */
  facilitatorToken: string;
  /** The JSON response schema the sidecar classifies against (declared-errors stay free). */
  classifierSchema: string;
  /** Override the handler's network (default PAIR_NETWORKS.handler). */
  handlerNetwork?: string;
  /** Override the sidecar's PRIMARY network (default PAIR_NETWORKS.sidecar). */
  sidecarNetwork?: string;
  /** Override the sidecar's EXTRA networks (default PAIR_NETWORKS.sidecarExtras). */
  sidecarExtraNetworks?: string[];
}

/** The result of a pair launch: both handles + both image tags. */
export interface LaunchResourcePairResult {
  /** The untrusted gate-less handler handle (stop() to tear down). */
  handler: ServiceHandle;
  /** The trusted sidecar gate handle (stop() to tear down). */
  sidecar: ServiceHandle;
  /** The image tag the handler runs. */
  handlerImage: string;
  /** The image tag the sidecar runs. */
  sidecarImage: string;
}

/**
 * Launch the two-container PAIR (Security review C1): an untrusted gate-less HANDLER
 * and a trusted SIDECAR gate, derived from one validated slug/resourceId.
 *
 * The handler holds NO facilitator route + NO token (buildResourceServiceSpec, the
 * untrusted secret-guarded path) and joins only the handler network. The sidecar
 * holds FACILITATOR_URL + the inspected HANDLER_URL + the caller-auth token + the
 * classifier schema (buildTrustedServiceSpec, which does NOT secret-guard so the
 * token is allowed) and joins ingress(primary)+controlplane+proxynet. The sidecar
 * reaches the handler by its inspected IP because the runsc sidecar cannot use Docker
 * DNS. Traefik routes to the SIDECAR (sidecarContainerUrl).
 *
 * It needs a LIVE docker daemon + runsc + wave BD's six-network topology, so it is
 * NEVER called from an autonomous test (the pure pieces are tested with stubs).
 *
 * @throws if either image is not built (a docker handle was provided, so both MUST
 *         build), the handler's IP cannot be inspected, or a spec is rejected.
 */
export async function launchResourcePair(
  docker: DockerHandle,
  opts: LaunchResourcePairOpts,
): Promise<LaunchResourcePairResult> {
  const { handlerName, sidecarName } = pairNames(opts.slug);
  const handlerNetwork = opts.handlerNetwork ?? PAIR_NETWORKS.handler;
  const sidecarNetwork = opts.sidecarNetwork ?? PAIR_NETWORKS.sidecar;
  const sidecarExtraNetworks = opts.sidecarExtraNetworks ?? [...PAIR_NETWORKS.sidecarExtras];

  const handlerImage = `utter-resource-${validateSlug(opts.slug)}-${ROLE_HANDLER}:latest`;
  const sidecarImage = `utter-resource-${validateSlug(opts.slug)}-${ROLE_GATE}:latest`;
  const dockerApi = docker as unknown as Docker;

  // (1) Bundle + build BOTH images. A docker handle was provided, so each build MUST
  // run; if it does not we cannot serve the pair, so fail loud rather than curling a
  // dead URL (same guard as launchEchoContainer).
  const handlerBundle = await bundleEchoHandler({
    outDir: join(tmpdir(), "utter-handler-bundle"),
    port: PAIR_PORT,
  });
  const handlerBuild = await buildResourceImage(handlerBundle.bundleDir, {
    runtime: "node",
    tag: handlerImage,
    docker: docker as unknown as Docker,
  });
  if (!handlerBuild.built) {
    throw new Error(
      `launchResourcePair: handler image '${handlerImage}' was not built (a docker handle ` +
        "was provided, so it must build). Confirm DEPLOY_BASE_IMAGE_NODE is a real digest-pinned base.",
    );
  }

  const sidecarBundle = await bundleSidecar({
    outDir: join(tmpdir(), "utter-sidecar-bundle"),
    port: PAIR_PORT,
  });
  const sidecarBuild = await buildResourceImage(sidecarBundle.bundleDir, {
    runtime: "node",
    tag: sidecarImage,
    docker: docker as unknown as Docker,
  });
  if (!sidecarBuild.built) {
    throw new Error(
      `launchResourcePair: sidecar image '${sidecarImage}' was not built (a docker handle ` +
        "was provided, so it must build). Confirm DEPLOY_BASE_IMAGE_NODE is a real digest-pinned base.",
    );
  }

  // (2) Idempotency: best-effort force-remove any prior handler AND sidecar so a
  // redeploy does not collide on the stable names. not-found is swallowed.
  for (const name of [handlerName, sidecarName]) {
    try {
      await dockerApi.getContainer(name).remove({ force: true });
    } catch {
      // No prior container (or already gone): nothing to clean up.
    }
  }

  // (3) Launch the HANDLER (untrusted) on the handler network. buildResourceServiceSpec
  // runs the secret guard over the gate-less env; the handler holds NO facilitator
  // route + NO token, so the env is purely allowlisted discovery config.
  const handlerSpec = buildResourceServiceSpec({
    backend: "gvisor",
    image: handlerImage,
    limits: ECHO_SERVICE.limits,
    network: handlerNetwork,
    env: buildHandlerServiceEnv({
      resourceId: opts.resourceId,
      cap: opts.cap,
      pricing: opts.pricing,
      maxTimeoutSeconds: opts.maxTimeoutSeconds,
      port: PAIR_PORT,
    }),
    name: handlerName,
    port: PAIR_PORT,
    labels: {
      [RESOURCE_ID_LABEL]: opts.resourceId,
      [SLUG_LABEL]: opts.slug,
      [ROLE_LABEL]: ROLE_HANDLER,
    },
  });
  const handler = await new GvisorRunner(docker).startService(handlerSpec);

  // (4) Inspect the handler's IP on its network. The runsc sidecar cannot use Docker
  // DNS (127.0.0.11), so it must reach the handler by literal IP - the name
  // `<slug>-handler` would EAI_AGAIN inside the sidecar's sandboxed netns.
  const inspected = await dockerApi.getContainer(handler.id).inspect();
  const ip = inspected.NetworkSettings?.Networks?.[handlerNetwork]?.IPAddress?.trim();
  if (!ip) {
    throw new Error(
      `launchResourcePair: could not resolve the handler's IP on network '${handlerNetwork}' ` +
        `(container ${handlerName}). The sidecar needs the IP because runsc cannot use Docker DNS.`,
    );
  }
  const handlerUrl = `http://${ip}:${PAIR_PORT}`;

  // (5) Launch the SIDECAR (trusted) on ingress(primary)+controlplane+proxynet.
  // buildTrustedServiceSpec carries the env verbatim (NO secret guard), so the
  // caller-auth token + classifier schema + facilitator route are accepted.
  const sidecarSpec = buildTrustedServiceSpec({
    backend: "gvisor",
    image: sidecarImage,
    limits: ECHO_SERVICE.limits,
    network: sidecarNetwork,
    extraNetworks: sidecarExtraNetworks,
    env: buildSidecarServiceEnv({
      facilitatorUrl: opts.facilitatorUrl,
      resourceId: opts.resourceId,
      cap: opts.cap,
      pricing: opts.pricing,
      maxTimeoutSeconds: opts.maxTimeoutSeconds,
      handlerUrl,
      facilitatorToken: opts.facilitatorToken,
      classifierSchema: opts.classifierSchema,
      port: PAIR_PORT,
    }),
    name: sidecarName,
    port: PAIR_PORT,
    labels: {
      [RESOURCE_ID_LABEL]: opts.resourceId,
      [SLUG_LABEL]: opts.slug,
      [ROLE_LABEL]: ROLE_GATE,
    },
  });
  const sidecar = await new GvisorRunner(docker).startService(sidecarSpec);

  return { handler, sidecar, handlerImage, sidecarImage };
}

/**
 * Tear down the two-container PAIR for a slug: list every container labeled with the
 * slug (both the handler + the gate), force-remove each (a missing container is a
 * no-op), then drop the Traefik route file. Best-effort: the goal is no live
 * container and no dangling route. Generalizes reapEchoContainer for the pair; the
 * legacy reapEchoContainer stays for the single-container path.
 */
export async function reapResourcePair(
  docker: DockerHandle,
  slug: string,
): Promise<void> {
  const validated = validateSlug(slug);
  const dockerApi = docker as unknown as Docker;

  const infos = await dockerApi.listContainers({
    all: true,
    filters: { label: [`${SLUG_LABEL}=${validated}`] },
  });
  for (const info of infos) {
    try {
      await dockerApi.getContainer(info.Id).remove({ force: true });
    } catch {
      // Already gone: nothing to remove.
    }
  }

  // Drop the route so Traefik stops advertising a backend that no longer exists.
  await removeTraefikDynamicFile(validated);
}

/**
 * The reconcile loop's `listContainers` provider on the host. Lists every managed
 * resource container (filtered by the resourceId label so platform containers are
 * never touched) and maps each to an {@link ActualContainer}: its dockerode id, the
 * resourceId + slug read back from the labels, whether it is running, and the
 * RestartCount (the runaway restart-loop signal).
 *
 * `listContainers` does NOT carry RestartCount, so each managed container is
 * inspected once to read `State.RestartCount` (cheap - one inspect per managed
 * container). Entries with no resourceId label are skipped (defensive: the filter
 * already requires the label).
 *
 * cpuFraction is intentionally left undefined this round: live CPU-stats streaming
 * is a documented follow-up. The runaway classifier already supports cpuFraction,
 * so the restart-loop signal works today and the CPU signal lights up when stats
 * land - the gap is explicit here, not hidden.
 */
export async function listResourceContainers(
  docker: DockerHandle,
): Promise<ActualContainer[]> {
  const dockerApi = docker as unknown as Docker;
  const infos = await dockerApi.listContainers({
    all: true,
    filters: { label: [RESOURCE_ID_LABEL] },
  });

  const result: ActualContainer[] = [];
  for (const info of infos) {
    const labels = info.Labels ?? {};
    const resourceId = labels[RESOURCE_ID_LABEL];
    if (!resourceId) continue; // no resourceId label: not a container we manage.

    // listContainers omits RestartCount; inspect once to read it (best-effort - a
    // missing/gone container leaves it undefined, treated as 0 by the classifier).
    let restartCount: number | undefined;
    try {
      const inspected = await dockerApi.getContainer(info.Id).inspect();
      // dockerode's State type omits RestartCount, but the daemon returns it; read
      // it through a narrow cast (it is a plain number on the inspect payload).
      const state = inspected.State as unknown as { RestartCount?: number };
      restartCount = state?.RestartCount;
    } catch {
      // Container vanished between list and inspect: leave restartCount undefined.
    }

    result.push({
      id: info.Id,
      resourceId: resourceId as Hex,
      slug: labels[SLUG_LABEL],
      running: info.State === "running",
      ...(restartCount !== undefined ? { restartCount } : {}),
      // cpuFraction left undefined: live CPU stats are a documented follow-up.
    });
  }
  return result;
}

/**
 * The reconcile loop's `reapContainer` provider on the host. Generalizes
 * {@link reapEchoContainer} to any managed container: force-remove it by its
 * dockerode id (a missing container is a no-op), then drop its Traefik dynamic file
 * if the slug is known. Best-effort: the goal is that a reaped container leaves no
 * live container and no dangling route behind.
 */
export async function reapResourceContainer(
  docker: DockerHandle,
  container: ActualContainer,
): Promise<void> {
  const dockerApi = docker as unknown as Docker;
  try {
    await dockerApi.getContainer(container.id).remove({ force: true });
  } catch {
    // Already gone: nothing to remove.
  }
  if (container.slug) {
    await removeTraefikDynamicFile(container.slug);
  }
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
