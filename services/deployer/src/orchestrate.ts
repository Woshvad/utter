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
import { bundleGeneratedHandler } from "./bundle-generated";
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

/** The named networks the pair joins (env-overridable for dev/back-compat).
 *
 * Per-resource isolation (quick 260625-mwb): the handler joins ONLY its per-slug
 * pairnet `utter_pairnet_<slug>` (internal:true), not a shared proxynet, so no sibling
 * handler can address it at L3 (the cross-tenant free-compute HIGH, RUNBOOK #1). The
 * sidecar's primary is ingress (Traefik reaches it there) plus controlplane (the
 * facilitator) and the SAME per-slug pairnet (the handler), and it DROPS the shared
 * proxynet. It reaches the handler by inspected IP on the shared pairnet (runsc has no
 * DNS). The pairnet name is derived per launch by {@link pairnetName}.
 *
 * The handler network and the sidecar extras are NOT in this constant: they are
 * derived per launch from the slug in launchResourcePair. The handler is pinned to its
 * per-slug pairnet `utter_pairnet_<slug>` and the sidecar extras are
 * `[controlplane, pairnet]` (NOT the shared proxynet). A dev-only override for each is
 * available via the LaunchResourcePairOpts `handlerNetwork` / `sidecarExtraNetworks`
 * fields (used by local back-compat runs); there is no env-var knob for them anymore
 * (the former HANDLER_NETWORK / SIDECAR_EXTRA_NETWORKS env vars were dead - never read -
 * and removed). This constant now holds ONLY the sidecar PRIMARY network (ingress,
 * where Traefik routes). The pairnet bridge driver is internal:true so no pairnet has a
 * route off-host.
 */
export const PAIR_NETWORKS = {
  /** The sidecar's PRIMARY network (Traefik routes to it here). Always ingress. */
  sidecar: process.env.SIDECAR_NETWORK?.trim() || "ingress",
} as const;

/** The Docker label value marking a per-resource pairnet (for the orphan-network GC sweep). */
export const PAIRNET_KIND_LABEL = "io.utter.kind";
/** The label VALUE for a per-resource pairnet. */
export const PAIRNET_KIND = "pairnet";

/**
 * The maximum length of a derived pairnet name. Docker network names are generous,
 * but we cap defensively so a pathological slug can never mint an unwieldy name. The
 * prefix `utter_pairnet_` is 14 chars, leaving a comfortable slug budget under 60.
 */
const MAX_PAIRNET_NAME_LENGTH = 60;

/**
 * Derive the per-resource pairnet name from a slug: `utter_pairnet_<slug>`. The slug
 * is validated `[a-z0-9-]` by validateSlug, so the name stays Docker-safe. A defensive
 * length cap throws a clear Error if the result would exceed {@link MAX_PAIRNET_NAME_LENGTH}.
 */
export function pairnetName(slug: string): string {
  const name = `utter_pairnet_${validateSlug(slug)}`;
  if (name.length > MAX_PAIRNET_NAME_LENGTH) {
    throw new Error(
      `pairnetName: derived network name '${name}' exceeds ${MAX_PAIRNET_NAME_LENGTH} chars. ` +
        "Use a shorter slug so the per-resource pairnet name stays Docker-safe.",
    );
  }
  return name;
}

/**
 * Idempotently create the per-resource pairnet for a slug: an internal:true bridge
 * named `utter_pairnet_<slug>`, labeled with the slug, the GC kind, AND the owning
 * resourceId so the orphan-network GC can find it and a slug-collision can be caught.
 * This MUST run BEFORE the handler container is created (the handler's pairnet is its
 * create-time NetworkMode).
 *
 * Slug-collision fail-loud guard (quick 260625-mwb, FIX C): the isolation guarantee
 * relies on globally-unique slugs (M5 prerequisite) - two resourceIds on one slug would
 * SHARE the pairnet and co-tenant, re-opening the cross-tenant free-compute HIGH. So on
 * the already-exists (409) path we inspect the existing pairnet and read its
 * RESOURCE_ID_LABEL: if it is present and does NOT equal this resourceId we THROW (refuse
 * to co-tenant); if it equals this resourceId it is a redeploy -> idempotent success; if
 * the label is absent (an older network created before this guard) we adopt it and
 * proceed. Any non-already-exists error is re-thrown.
 */
async function ensurePairNetwork(
  docker: DockerHandle,
  slug: string,
  resourceId: Hex,
): Promise<void> {
  const dockerApi = docker as unknown as Docker;
  const name = pairnetName(slug);
  try {
    await dockerApi.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: true,
      CheckDuplicate: true,
      Labels: {
        [SLUG_LABEL]: validateSlug(slug),
        [PAIRNET_KIND_LABEL]: PAIRNET_KIND,
        [RESOURCE_ID_LABEL]: resourceId,
      },
    });
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    const alreadyExists =
      e?.statusCode === 409 || (e?.message ?? "").toLowerCase().includes("already exists");
    if (!alreadyExists) throw err;

    // A pairnet for this slug already exists. Inspect it and enforce single-ownership:
    // refuse to co-tenant a slug across two different resourceIds (slugs MUST be globally
    // unique for isolation - M5). A matching owner is a redeploy (idempotent success); an
    // unlabeled older network is adopted.
    const info = await dockerApi.getNetwork(name).inspect();
    const owner = (info.Labels ?? {})[RESOURCE_ID_LABEL];
    if (owner && owner !== resourceId) {
      throw new Error(
        `ensurePairNetwork: the pairnet '${name}' is already owned by a different resource. ` +
          "Refusing to co-tenant: resource slugs must be globally unique for per-resource " +
          "isolation (M5 prerequisite). Mint a unique slug for this resource.",
      );
    }
    // Same owner (redeploy) or unlabeled legacy net (adopt): idempotent success.
  }
}

/**
 * Best-effort remove the per-resource pairnet for a slug, but ONLY when no container
 * is still attached to it. If endpoints remain (a sibling role not yet reaped), leave
 * it for {@link reapOrphanPairNetworks} to sweep once it is endpoint-less. Never throws
 * out of a reap (a 404 / already-gone / in-use is swallowed). Logs no secret material.
 */
async function removePairNetwork(docker: DockerHandle, slug: string): Promise<void> {
  const dockerApi = docker as unknown as Docker;
  const name = pairnetName(slug);
  try {
    const net = dockerApi.getNetwork(name);
    const info = await net.inspect();
    const attached = Object.keys(info.Containers ?? {}).length;
    if (attached > 0) {
      // A sibling endpoint is still attached: leave it for the GC sweep (never force a
      // remove that would fail in-use; never let "ignore in-use" become a silent leak).
      return;
    }
    await net.remove();
  } catch {
    // Already gone (404), a race, or transiently in-use: best-effort, the GC is the
    // safety net. Swallow without logging any identifier beyond the safe slug above.
  }
}

/**
 * The orphan-network GC sweep: list every labeled per-resource pairnet
 * (`io.utter.kind=pairnet`), inspect each, and remove any with zero attached
 * containers. This is the safety net that closes the network leak under crashes /
 * races where a pairnet outlives its containers (the reconcile loop wires it as a
 * per-tick hook). Best-effort per network: a remove that races or is in-use is skipped.
 */
export async function reapOrphanPairNetworks(docker: DockerHandle): Promise<void> {
  const dockerApi = docker as unknown as Docker;
  const nets = await dockerApi.listNetworks({
    filters: { label: [`${PAIRNET_KIND_LABEL}=${PAIRNET_KIND}`] },
  });
  for (const summary of nets) {
    try {
      const net = dockerApi.getNetwork(summary.Id);
      const info = await net.inspect();
      const attached = Object.keys(info.Containers ?? {}).length;
      if (attached > 0) continue; // still in use: not an orphan.
      await net.remove();
    } catch {
      // A race (removed between list and remove) or transient in-use: skip it.
    }
  }
}

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
  /**
   * The EXACT discovery routes that BYPASS the gate (sidecar FREE_PATHS, an exact CSV).
   * Optional: defaults to the single agent-card route ({@link DEFAULT_SIDECAR_FREE_PATHS}),
   * the echo's only free route. Each entry is matched exactly, never by prefix (#3).
   */
  freePaths?: string[];
  /**
   * The resource's A2A agent card (JSON string) the sidecar serves at the card path. Emitted
   * as AGENT_CARD_JSON when set; absent (echo) -> the card path proxies to the handler. It is
   * public platform metadata (the finalized agent-card.json from the gated bundle), not a secret.
   */
  agentCard?: string;
  /** The container listen port. */
  port: number;
}

/**
 * The deployer's per-resource default for the sidecar FREE_PATHS env: ONLY the A2A
 * agent card. The echo's sole free route is its discovery card; health is served
 * behind the gate for a deployed resource (the in-sidecar DEFAULT_FREE_PATHS trio is
 * the wider in-process default, but a live deploy narrows it to exactly the declared
 * discovery route so no extra path is bypassed). Each entry is an EXACT match (#3).
 */
export const DEFAULT_SIDECAR_FREE_PATHS = ["/.well-known/agent-card.json"] as const;

/**
 * Assemble the TRUSTED sidecar container env (sidecar.ts loadSidecarConfig:
 * FACILITATOR_URL, RESOURCE_ID, CAP, MAX_TIMEOUT_SECONDS, PRICE_*, MAX_RESPONSE_BYTES,
 * HANDLER_URL, SIDECAR_FACILITATOR_TOKEN, CLASSIFIER_SCHEMA, FREE_PATHS, PORT).
 *
 * This env carries the facilitator route + the caller-auth token + the classifier
 * schema, so it MUST go through buildTrustedServiceSpec (which does NOT run the secret
 * guard); buildResourceServiceSpec would reject the token. NEVER logs the token.
 *
 * MAX_RESPONSE_BYTES is emitted ONLY when pricing.maxResponseBytes is a positive
 * number (fix F2 - it caps the metering size term AND bounds the sidecar's proxy read;
 * loadSidecarConfig falls back to its hard default when it is absent). It is a public
 * integer. FREE_PATHS is the comma-joined exact discovery routes, defaulting to the
 * single agent-card route so a live deploy bypasses the gate on EXACTLY that route,
 * not the wider in-sidecar default trio.
 */
export function buildSidecarServiceEnv(opts: BuildSidecarServiceEnvOpts): Record<string, string> {
  const env: Record<string, string> = {
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

  // Emit MAX_RESPONSE_BYTES ONLY when the pricing carries a positive cap (fix F2). A
  // missing/zero/negative value is omitted so loadSidecarConfig keeps its hard
  // default; emitting "0" would be parsed away by F1 but is misleading, so we omit.
  const maxResponseBytes = opts.pricing.maxResponseBytes;
  if (typeof maxResponseBytes === "number" && maxResponseBytes > 0) {
    env.MAX_RESPONSE_BYTES = String(maxResponseBytes);
  }

  // Emit FREE_PATHS as the comma-joined EXACT discovery routes; default to the single
  // agent-card route (the echo's only free route). loadSidecarConfig splits it back on
  // commas and matches each entry exactly, never by prefix (#3).
  const freePaths = opts.freePaths ?? [...DEFAULT_SIDECAR_FREE_PATHS];
  env.FREE_PATHS = freePaths.join(",");

  // Emit the A2A agent card so the sidecar serves it at the card path (the untrusted handler
  // has no card route; without this the free card path proxies to the handler and 404s, which
  // fails agent discovery + the marketplace publish probe). Public metadata, never a secret.
  if (opts.agentCard && opts.agentCard.trim().length > 0) {
    env.AGENT_CARD_JSON = opts.agentCard;
  }

  return env;
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
  /**
   * The EXACT discovery routes the sidecar bypasses the gate on (FREE_PATHS). Optional:
   * defaults to {@link DEFAULT_SIDECAR_FREE_PATHS} (the single agent-card route). Each
   * entry is matched exactly, never by prefix (#3).
   */
  freePaths?: string[];
  /**
   * The resource's A2A agent card (JSON string) the trusted sidecar serves at the card path
   * (the untrusted handler has no card route). Threaded to buildSidecarServiceEnv as
   * AGENT_CARD_JSON; absent (echo) -> the card path proxies to the handler. Not a secret.
   */
  agentCard?: string;
  /** Dev-only override for the handler's network (default: the per-slug pairnet). */
  handlerNetwork?: string;
  /** Override the sidecar's PRIMARY network (default PAIR_NETWORKS.sidecar = ingress). */
  sidecarNetwork?: string;
  /** Dev-only override for the sidecar's EXTRA networks (default: [controlplane, pairnet]). */
  sidecarExtraNetworks?: string[];
  /**
   * The GENERATED (untrusted) bundle dir to build the HANDLER image from. When set, the
   * handler image is built from this dir via bundleGeneratedHandler: the dir already has
   * handler.ts written by writeBundleToDir and has ALREADY passed the pre-build gate
   * (gateGeneratedBundle, fail-closed), and bundleGeneratedHandler structurally re-gates
   * it again at its top (defense in depth). When ABSENT (the default / back-compat), the
   * echo gate-less handler is bundled via bundleEchoHandler.
   *
   * The trusted SIDECAR is ALWAYS bundled via bundleSidecar and is untouched by this
   * option. The untrusted bundle NEVER influences slug, on-chain resourceId, or pricing:
   * those come from the typed opts fields above (trusted control-plane inputs).
   */
  handlerBundleDir?: string;
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
 * untrusted secret-guarded path) and joins ONLY its per-slug internal pairnet
 * `utter_pairnet_<slug>` (created here first). The sidecar holds FACILITATOR_URL + the
 * inspected HANDLER_URL + the caller-auth token + the classifier schema
 * (buildTrustedServiceSpec, which does NOT secret-guard so the token is allowed) and
 * joins ingress(primary)+controlplane+pairnet (it DROPS the shared proxynet). The
 * sidecar reaches the handler by its inspected IP on the shared pairnet because the
 * runsc sidecar cannot use Docker DNS. Cross-tenant handler-to-handler is blocked at
 * the Docker layer by disjoint internal bridges. Traefik routes to the SIDECAR
 * (sidecarContainerUrl).
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
  // Per-resource isolation (quick 260625-mwb): the handler joins ONLY its per-slug
  // internal pairnet (no shared proxynet), and the sidecar's extras are
  // [controlplane, pairnet] (also dropping proxynet). The env-override knobs still win
  // for dev/back-compat.
  const pairnet = pairnetName(opts.slug);
  const handlerNetwork = opts.handlerNetwork ?? pairnet;
  const sidecarNetwork = opts.sidecarNetwork ?? PAIR_NETWORKS.sidecar;
  const sidecarExtraNetworks = opts.sidecarExtraNetworks ?? ["controlplane", pairnet];

  const handlerImage = `utter-resource-${validateSlug(opts.slug)}-${ROLE_HANDLER}:latest`;
  const sidecarImage = `utter-resource-${validateSlug(opts.slug)}-${ROLE_GATE}:latest`;
  const dockerApi = docker as unknown as Docker;

  // (1) Bundle + build BOTH images. A docker handle was provided, so each build MUST
  // run; if it does not we cannot serve the pair, so fail loud rather than curling a
  // dead URL (same guard as launchEchoContainer).
  //
  // When a GENERATED bundle dir is given, build the handler image from it (the dir was
  // written by writeBundleToDir + already gated; bundleGeneratedHandler re-gates it
  // structurally at its top). Otherwise bundle the echo gate-less handler as before
  // (default / back-compat). The sidecar path below is unchanged either way.
  const handlerBundle = opts.handlerBundleDir
    ? await bundleGeneratedHandler(opts.handlerBundleDir, { port: PAIR_PORT })
    : await bundleEchoHandler({
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

  // (2b) Create the per-resource pairnet BEFORE the handler container (ordering fix:
  // the handler's pairnet is its create-time NetworkMode, so the network must exist
  // first). Idempotent on already-exists for a same-owner redeploy; THROWS on a
  // slug-collision where a different resourceId already owns this pairnet (FIX C, the
  // network-layer fail-loud guard for global slug uniqueness). When a dev override pins
  // the handler to a pre-existing shared network we still ensure the per-slug pairnet so
  // the GC + teardown paths stay consistent.
  await ensurePairNetwork(docker, opts.slug, opts.resourceId);

  // (3) Launch the HANDLER (untrusted) on its per-slug internal pairnet.
  // buildResourceServiceSpec runs the secret guard over the gate-less env; the handler
  // holds NO facilitator route + NO token, so the env is purely allowlisted discovery
  // config. The handler is on the pairnet ALONE: no sibling handler can reach it at L3.
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

  // (5) Launch the SIDECAR (trusted) on ingress(primary)+controlplane+pairnet (it does
  // NOT join the shared proxynet). buildTrustedServiceSpec carries the env verbatim (NO
  // secret guard), so the caller-auth token + classifier schema + facilitator route are
  // accepted. The sidecar shares the per-slug pairnet with its handler (reaches it by IP).
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
      ...(opts.freePaths ? { freePaths: opts.freePaths } : {}),
      // The sidecar serves this card at the card path (the handler has no card route).
      ...(opts.agentCard ? { agentCard: opts.agentCard } : {}),
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

  // Remove the per-resource pairnet now that every slug container is gone (quick
  // 260625-mwb). Best-effort: a missing/in-use network is left for the orphan GC.
  await removePairNetwork(docker, validated);
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
 *
 * Per-resource pairnet teardown (quick 260625-mwb, the FATAL fix): the production
 * reconcile loop reaps via THIS per-container hook, not reapResourcePair. So after the
 * container is removed, if its slug is known we attempt to remove the per-resource
 * pairnet via removePairNetwork, which is AUTHORITATIVE: it gates off the network's OWN
 * endpoint list (network.inspect().Containers) and removes the bridge only when zero
 * endpoints remain. When a container is force-removed it detaches from the pairnet, so
 * the network's Containers map is the source of truth for "is this the last role". There
 * is therefore no listContainers timing dependency and no race here - if a sibling role
 * is still attached, removePairNetwork sees its endpoint and declines; if this was the
 * last role, its endpoint is already gone and the bridge is removed. The orphan-network
 * GC remains the backstop for any crash/race straggler. Best-effort: a removal failure
 * is swallowed inside removePairNetwork (the GC is the net).
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

    // Remove the per-resource pairnet. removePairNetwork is authoritative: it inspects
    // the network's OWN endpoint list and removes the bridge only when zero endpoints
    // remain. The just-removed container has already detached, so if a sibling role is
    // still attached the network keeps its endpoint and the remove is declined; if this
    // was the last role the bridge is gone. No listContainers timing dependency, no race.
    await removePairNetwork(docker, container.slug);
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
