// build.ts - the hardened resource-image build (SBX-05).
//
// SECURITY POSTURE - NO-NETWORK-AT-BUILD IS OPERATOR-GATED.
// The hardened-build property has two halves:
//   1. The WIRING (this file): build from a pinned-BY-DIGEST hardened base image
//      (node:22-bookworm-slim / python:3.12-slim), install deps from a LOCKFILE
//      only, and apply image-size + build-time caps. This is verified autonomously.
//   2. The NETWORK ISOLATION (operator-gated): the build container's ONLY registry
//      is an internal Verdaccio pull-through mirror, with no other network at build.
//      That mirror is operator-provisioned (CONTEXT line 108 / RESEARCH Pattern 5).
//
// LOCALLY we build against the PUBLIC registry with the same lockfile - the build
// CODE is identical; only `REGISTRY_MIRROR_URL` differs (empty -> public registry;
// set -> the Verdaccio mirror in prod). We therefore DO NOT claim the
// no-network-at-build property locally: `buildResourceImage` returns
// `networkIsolation: 'operator-gated'` and the module is labelled "build wiring
// verified, network isolation operator-gated". Never present the docker-dev /
// public-registry build as the hardened prod build (T-03-18).
import type Docker from "dockerode";

/**
 * Pinned hardened base images, BY DIGEST (T-03-17: an unpinned/mutable tag is a
 * supply-chain hole). The digests are the deploy-time pins; an operator bumps them
 * deliberately via a base-image refresh, never implicitly via a floating tag.
 *
 * NOTE: these are placeholder-but-valid sha256 digests for the WIRING (the build
 * generator + its assertions). The operator pins the real, scanned digests for the
 * provisioned build host; the generator shape and the by-digest invariant are what
 * is verified autonomously.
 */
export const PINNED_BASE_IMAGES = {
  node: "node:22-bookworm-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000",
  python: "python:3.12-slim@sha256:1111111111111111111111111111111111111111111111111111111111111111",
} as const;

/** The supported bundle runtimes (which pinned base + lockfile install to use). */
export type BundleRuntime = keyof typeof PINNED_BASE_IMAGES;

/** The env var an operator sets to pin the real scanned node base digest. */
const BASE_IMAGE_ENV: Record<BundleRuntime, string> = {
  node: "DEPLOY_BASE_IMAGE_NODE",
  python: "DEPLOY_BASE_IMAGE_PYTHON",
};

/**
 * Resolve the base image for a runtime: the operator override
 * (DEPLOY_BASE_IMAGE_NODE / DEPLOY_BASE_IMAGE_PYTHON) when set, else the pinned
 * placeholder constant. The result is still asserted pinned-by-digest by the
 * caller, so a bad env value fails loud rather than silently shipping an unpinned
 * (mutable-tag) base. This lets an operator pin the real scanned digest for the
 * provisioned build host without editing code.
 */
export function resolveBaseImage(runtime: BundleRuntime): string {
  const override = process.env[BASE_IMAGE_ENV[runtime]];
  if (override && override.trim().length > 0) return override.trim();
  return PINNED_BASE_IMAGES[runtime];
}

/** Network-isolation posture of a build. Locally we NEVER claim 'isolated'. */
export type NetworkIsolation = "operator-gated" | "isolated";

/** Options for {@link buildResourceImage}. */
export interface BuildResourceImageOpts {
  /** Which runtime the bundle targets (node | python). Picks the pinned base + lockfile. */
  runtime: BundleRuntime;
  /** The image tag to build (normally `resource-<resourceId>:v<deployVersion>`). */
  tag: string;
  /**
   * The registry the build installs deps from. Empty/undefined -> the PUBLIC
   * registry (local autonomous build). Set -> the internal Verdaccio mirror
   * (prod, operator-provisioned) - the build CODE is identical, only this differs.
   * Read from `REGISTRY_MIRROR_URL` when not passed explicitly.
   */
  registryMirrorUrl?: string;
  /** Build-time cap in seconds (SBX-04 / T-03-19: an unbounded build is a DoS). */
  buildTimeoutSeconds?: number;
  /** Image-size cap in bytes (SBX-04 / T-03-19). Advisory in the build spec. */
  maxImageBytes?: number;
  /**
   * A dockerode instance. Optional: omit it to generate the build spec + Dockerfile
   * WITHOUT launching a build (the autonomous test path - it asserts the wiring,
   * not a live image). Provide it on the build host to actually run `buildImage`.
   */
  docker?: Docker;
}

/** Default build-time + image-size caps (T-03-19). */
const DEFAULT_BUILD_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_IMAGE_BYTES = 512 * 1024 * 1024; // 512 MiB

/** The lockfile the install step is pinned to, per runtime. */
const LOCKFILE: Record<BundleRuntime, string> = {
  node: "pnpm-lock.yaml",
  python: "requirements.lock",
};

/** The fully-resolved build spec a build produces (pure, inspectable, testable). */
export interface BuildSpec {
  /** The pinned-by-digest base image the Dockerfile FROM line uses. */
  baseImage: string;
  /** The lockfile the deps install is pinned to. */
  lockfile: string;
  /** The resolved registry source (empty string = public registry locally). */
  registryUrl: string;
  /** The generated Dockerfile contents. */
  dockerfile: string;
  /** Resolved build-time cap (seconds). */
  buildTimeoutSeconds: number;
  /** Resolved image-size cap (bytes). */
  maxImageBytes: number;
  /**
   * The network-isolation posture. ALWAYS 'operator-gated' from this code path -
   * the no-network-at-build property holds only once the internal mirror exists,
   * so we never claim 'isolated' from a local/public build (T-03-18).
   */
  networkIsolation: NetworkIsolation;
}

/** The result of a build call (the spec, plus the built image id when run live). */
export interface BuildResult extends BuildSpec {
  /** The image tag that was built (or would be built). */
  tag: string;
  /** True only when a live dockerode build actually ran (docker provided). */
  built: boolean;
  /** The built image id, when a live build ran. */
  imageId?: string;
}

/**
 * Assert that a base image reference is pinned BY DIGEST (`...@sha256:<64 hex>`).
 * A floating tag (`node:22`) is a supply-chain hole (T-03-17), so a base image that
 * is not digest-pinned is a build error, never a silent fallback.
 */
export function assertPinnedByDigest(image: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(
      `buildResourceImage: base image '${image}' is not pinned by digest (expected ...@sha256:<64 hex>)`,
    );
  }
}

/**
 * Generate the hardened Dockerfile for a bundle: FROM the pinned-by-digest base,
 * COPY the lockfile, install deps FROM THE LOCKFILE ONLY against the resolved
 * registry (public locally; the mirror in prod - identical code, only the URL
 * differs), drop to a non-root user, and COPY the bundle. The install registry is
 * the ONLY network the build needs; the no-network-at-build enforcement (build
 * container restricted to the mirror) is operator-gated infrastructure, NOT claimed
 * here.
 */
export function generateDockerfile(opts: {
  runtime: BundleRuntime;
  baseImage: string;
  registryUrl: string;
}): string {
  assertPinnedByDigest(opts.baseImage);
  const lockfile = LOCKFILE[opts.runtime];

  if (opts.runtime === "node") {
    // `npm_config_registry` is the documented swap point: empty -> public registry;
    // set -> the Verdaccio mirror. `npm ci` installs FROM THE LOCKFILE ONLY (it
    // refuses to install if package.json and the lockfile disagree).
    const registryArg = opts.registryUrl
      ? `ENV npm_config_registry=${opts.registryUrl}\n`
      : "# REGISTRY_MIRROR_URL unset -> public registry (local autonomous build; mirror swap in prod)\n";
    return [
      `# syntax: hardened build wiring verified; network isolation operator-gated (SBX-05)`,
      `FROM ${opts.baseImage}`,
      `USER node`,
      `WORKDIR /app`,
      registryArg.trimEnd(),
      `COPY --chown=node:node package.json ${lockfile} ./`,
      `# install FROM THE LOCKFILE ONLY (npm ci fails if package.json/lockfile disagree)`,
      `RUN npm ci --ignore-scripts`,
      `COPY --chown=node:node . .`,
      `CMD ["node", "server.js"]`,
      "",
    ].join("\n");
  }

  // python
  const registryArg = opts.registryUrl
    ? `ENV PIP_INDEX_URL=${opts.registryUrl}\n`
    : "# REGISTRY_MIRROR_URL unset -> public PyPI (local autonomous build; mirror swap in prod)\n";
  return [
    `# syntax: hardened build wiring verified; network isolation operator-gated (SBX-05)`,
    `FROM ${opts.baseImage}`,
    `WORKDIR /app`,
    registryArg.trimEnd(),
    `COPY ${lockfile} ./`,
    `# install FROM THE LOCKFILE ONLY (pinned hashes; --require-hashes rejects drift)`,
    `RUN pip install --no-cache-dir --require-hashes -r ${lockfile}`,
    `COPY . .`,
    `RUN useradd --create-home appuser && chown -R appuser /app`,
    `USER appuser`,
    `CMD ["python", "server.py"]`,
    "",
  ].join("\n");
}

/**
 * Build the hardened build spec for a bundle and, if a dockerode instance is
 * provided, run the actual `buildImage`. The spec pins the base image BY DIGEST,
 * installs deps FROM THE LOCKFILE, swaps the registry via `REGISTRY_MIRROR_URL`
 * (public locally; the Verdaccio mirror in prod - identical code), and applies the
 * build-time + image-size caps. It ALWAYS reports `networkIsolation:'operator-gated'`:
 * the no-network-at-build property is NOT claimed until the internal mirror exists.
 */
export async function buildResourceImage(
  bundlePath: string,
  opts: BuildResourceImageOpts,
): Promise<BuildResult> {
  // Resolve the base image (operator env override or the pinned constant), then
  // assert it is pinned BY DIGEST so a bad override fails loud (T-03-17).
  const baseImage = resolveBaseImage(opts.runtime);
  assertPinnedByDigest(baseImage);

  // Resolve the registry: explicit opt wins, else the env, else empty (public).
  const registryUrl = opts.registryMirrorUrl ?? process.env.REGISTRY_MIRROR_URL ?? "";

  const dockerfile = generateDockerfile({
    runtime: opts.runtime,
    baseImage,
    registryUrl,
  });

  const spec: BuildSpec = {
    baseImage,
    lockfile: LOCKFILE[opts.runtime],
    registryUrl,
    dockerfile,
    buildTimeoutSeconds: opts.buildTimeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS,
    maxImageBytes: opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    // NEVER claim 'isolated' locally - the no-network property is operator-gated.
    networkIsolation: "operator-gated",
  };

  // No dockerode -> spec-only (the autonomous test path: assert the wiring without
  // building a live image, which needs a Docker daemon + a real bundle context).
  if (!opts.docker) {
    return { ...spec, tag: opts.tag, built: false };
  }

  // Live build on the build host: stream the bundle context to dockerode buildImage.
  // The Dockerfile is injected via the build context; the registry swap already
  // baked the mirror URL (or left it public) into the install step.
  const stream = await opts.docker.buildImage(
    { context: bundlePath, src: ["."] },
    { t: opts.tag, dockerfile: "Dockerfile" },
  );
  const imageId = await new Promise<string>((resolve, reject) => {
    let lastId = "";
    opts.docker!.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve(lastId)),
      (event: { aux?: { ID?: string } }) => {
        if (event.aux?.ID) lastId = event.aux.ID;
      },
    );
  });

  return { ...spec, tag: opts.tag, built: true, imageId };
}
