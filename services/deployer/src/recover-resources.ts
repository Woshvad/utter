// recover-resources.ts - OPERATOR-GATED one-shot RECOVERY of already-deployed resources.
//
// It re-serves + re-publishes resources that are ALREADY running on the host but were
// never listed in the marketplace (they predate one of the publish-pipeline fixes: the
// card-serving sidecar / the finalized payTo card / the marketplace egress). It
// regenerates NOTHING and needs NO AI/API credit: the untrusted HANDLER image + its
// running container are reused as-is, and each resource's A2A agent card is rebuilt from
// the running SIDECAR's own env + @utter/chain constants.
//
// PURELY ADDITIVE. It imports the existing deploy helpers and never edits the normal
// create -> deploy -> publish path, so a NEW resource created later still deploys, lists,
// and shows exactly as it does today. The money path, the escrow gate, and the contracts
// are BYTE-UNCHANGED: this only (a) hot-swaps each resource's TRUSTED sidecar for the
// current card-serving build (the untrusted handler keeps running, untouched) and (b)
// POSTs the finalized card to the marketplace publish endpoint - the exact same publish
// step a normal deploy runs.
//
// HOST-GATED (UTTER_SANDBOX_HOST=1) like live-deploy.ts. DEFAULTS TO DRY-RUN: it prints
// the per-resource plan and mutates NOTHING until run with `--apply`.
//
// SECURITY: keys/secrets are read ONLY from .env.local (gitignored) and are NEVER logged.
// The re-minted sidecar facilitator token and the marketplace publish bearer never appear
// in a log or a thrown message.
import { config as loadEnv } from "dotenv";
import type Docker from "dockerode";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Hex } from "viem";
import {
  createArcPublicClient,
  RESOURCE_REGISTRY,
  registryAbi,
  USDC,
  PAYMENT_ESCROW,
  ARC_CHAIN_ID,
  ARC_CAIP2_NETWORK,
} from "@utter/chain";
import type { Pricing } from "@utter/x402-arc";
import { GvisorRunner, buildTrustedServiceSpec } from "@utter/sandbox";
import {
  resolveDockerHandle,
  resolveFacilitatorUrl,
  buildSidecarServiceEnv,
  writeTraefikDynamicFile,
  sidecarContainerUrl,
  pairNames,
  pairnetName,
  DEFAULT_SIDECAR_FREE_PATHS,
  PAIR_NETWORKS,
  PAIR_PORT,
  ECHO_SERVICE,
  RESOURCE_ID_LABEL,
  SLUG_LABEL,
  ROLE_LABEL,
  ROLE_GATE,
  ROLE_HANDLER,
  type DockerHandle,
} from "./orchestrate";
import { bundleSidecar } from "./bundle-echo";
import { buildResourceImage } from "./build";
import { mintFacilitatorToken } from "./facilitator-token";

// Load .env.local from the repo root (module-relative, NOT cwd), mirroring
// live-deploy.ts so `node src/recover-resources.ts` works from either the repo root or
// services/deployer. quiet:true keeps dotenv's banner off stdout.
loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env.local"),
  quiet: true,
});

/** The shared tag the current card-serving sidecar image is (re)built under for recovery. */
export const RECOVERY_SIDECAR_IMAGE = "utter-recovery-sidecar:latest";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests - no docker, no network).
// ---------------------------------------------------------------------------

/**
 * Parse a dockerode `Config.Env` array (`["KEY=value", ...]`) into a map. Splits on the
 * FIRST `=` only, so a value that itself contains `=` (a JSON classifier schema / agent
 * card) round-trips intact. A missing/empty array yields an empty map.
 */
export function parseEnvArray(env: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!env) return map;
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue; // no key, or a leading '=': skip
    map[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return map;
}

/** The recovered per-resource facts read back from a running sidecar's env. */
export interface RecoveredResource {
  /** The on-chain resourceId (bytes32) - the escrow payTo + the card payTo. */
  resourceId: Hex;
  /** The signed spend cap (USDC base units) advertised in the 402 quote. */
  cap: bigint;
  /** The x402-arc metered pricing, shaped to round-trip back through buildSidecarServiceEnv. */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). */
  maxTimeoutSeconds: number;
  /** The JSON response schema the sidecar classifies declared-errors against. */
  classifierSchema: string;
  /** The EXACT discovery routes the sidecar bypasses the gate on (FREE_PATHS). */
  freePaths: string[];
  /**
   * The A2A card the sidecar was already serving (AGENT_CARD_JSON), present only on a
   * sidecar built AFTER the card-serving fix. Absent on an older sidecar -> the card is
   * reconstructed from the slug + pricing instead.
   */
  agentCardJson?: string;
}

/** A required-env-key read that names every missing key at once (never logs a value). */
function requireKeys(env: Record<string, string>, keys: string[]): void {
  const missing = keys.filter((k) => !(env[k] && env[k].trim().length > 0));
  if (missing.length > 0) {
    throw new Error(`sidecar env is missing required key(s): ${missing.join(", ")}`);
  }
}

/**
 * Read a {@link RecoveredResource} out of a running sidecar's env map (the output of
 * {@link parseEnvArray}). The PRICE_* -> pricing mapping is the exact inverse of
 * buildSidecarServiceEnv (PRICE_MAX <- computeMultiplier), so the reconstructed pricing
 * round-trips back to the identical env when the sidecar is relaunched. Throws a clear,
 * value-free error if a required key is missing.
 */
export function parseSidecarEnv(env: Record<string, string>): RecoveredResource {
  requireKeys(env, [
    "RESOURCE_ID",
    "CAP",
    "MAX_TIMEOUT_SECONDS",
    "PRICE_BASE",
    "PRICE_PER_KB",
    "PRICE_MAX",
    "CLASSIFIER_SCHEMA",
  ]);
  // requireKeys threw above if any were missing, so these non-null reads are safe (the
  // `!` only satisfies noUncheckedIndexedAccess, which cannot see through requireKeys).
  const resourceId = env.RESOURCE_ID! as Hex;
  const cap = BigInt(env.CAP!);
  const maxTimeoutSeconds = Number(env.MAX_TIMEOUT_SECONDS!);

  const pricing: Pricing = {
    model: "metered",
    base: env.PRICE_BASE!,
    perKB: env.PRICE_PER_KB!,
    // buildSidecarServiceEnv emits PRICE_MAX FROM pricing.computeMultiplier; invert it here.
    computeMultiplier: env.PRICE_MAX!,
    ...(env.MAX_RESPONSE_BYTES && /^[0-9]+$/.test(env.MAX_RESPONSE_BYTES)
      ? { maxResponseBytes: Number(env.MAX_RESPONSE_BYTES) }
      : {}),
  };

  const freePaths =
    env.FREE_PATHS && env.FREE_PATHS.trim().length > 0
      ? env.FREE_PATHS.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
      : [...DEFAULT_SIDECAR_FREE_PATHS];

  return {
    resourceId,
    cap,
    pricing,
    maxTimeoutSeconds,
    classifierSchema: env.CLASSIFIER_SCHEMA!,
    freePaths,
    ...(env.AGENT_CARD_JSON && env.AGENT_CARD_JSON.trim().length > 0
      ? { agentCardJson: env.AGENT_CARD_JSON }
      : {}),
  };
}

/** Turn a discovery slug back into a readable prompt (`score-the-sentiment` -> `score the sentiment`). */
export function deslugToPrompt(slug: string): string {
  const prompt = slug.replace(/-+/g, " ").trim();
  return prompt.length > 0 ? prompt : "resource";
}

/** The finalized card + its served URLs for a recovered resource. */
export interface RecoveredCard {
  /** The finalized card as a JSON string (payTo = resourceId, url = the resource base). */
  finalizedJson: string;
  /** The resource base URL (`https://<slug>.resources.<domain>`) stamped onto card.url. */
  cardBaseUrl: string;
  /** The absolute card URL the marketplace probe fetches + the publish records. */
  cardUrl: string;
  /** Whether the card came from the sidecar env (true) or was reconstructed (false). */
  fromServedCard: boolean;
}

/** The advisory card pricing block (mirrors @utter/ai-runtime ResourceSpec.pricing). */
interface CardPricing {
  model: "metered";
  base: string;
  perKB: string;
  max: string;
}

/**
 * A slug derived from a prompt, IDENTICAL to @utter/ai-runtime agent-card.ts slugify (kept
 * in lockstep). Lowercase, hyphen-collapsed, trimmed, bounded to 48 chars.
 */
function slugifyPrompt(prompt: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "resource";
}

/**
 * Build the A2A v0.3.0 flat card for a recovered resource. This is an INLINE copy of
 * @utter/ai-runtime buildAgentCard (the deployer must not take the heavy ai-runtime dep):
 * the shape is the pinned A2A v0.3.0 schema the marketplace validateAgentCard enforces, and
 * asset/escrow/network/chainId come from @utter/chain (never re-literal'd). Keep in lockstep
 * with packages/ai-runtime/src/agent-card.ts if that schema ever changes.
 */
function buildRecoveredAgentCard(prompt: string, pricing: CardPricing): Record<string, unknown> {
  const slug = slugifyPrompt(prompt);
  const description = prompt.trim();
  return {
    protocolVersion: "0.3.0",
    name: slug,
    description,
    url: `https://${slug}.resources.example`, // placeholder; finalized below
    version: "1.0.0",
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: slug,
        name: slug,
        description,
        tags: ["utter", "x402"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    x402: {
      scheme: "utter-escrow",
      network: ARC_CAIP2_NETWORK,
      chainId: ARC_CHAIN_ID,
      asset: USDC,
      escrow: PAYMENT_ESCROW,
      pricing,
      payTo: `placeholder-${slug}`, // finalized below
    },
    cache: { ttlSeconds: 30 },
    identity: { standard: "erc-8004", chainId: ARC_CHAIN_ID, agentId: "placeholder" },
    health: { verified: false, score: null },
    bond: { posted: false },
  };
}

/**
 * Stamp the real resourceId payTo (+ base url) onto a card JSON string. INLINE copy of
 * @utter/ai-runtime finalizeAgentCard: payTo = resourceId is load-bearing (the marketplace
 * payTo-binding gate refuses a card whose payTo != resourceId). Preserves every other field.
 */
function finalizeCardJson(cardJson: string, opts: { resourceId: string; url?: string }): string {
  const card = JSON.parse(cardJson) as Record<string, unknown>;
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  card.x402 = { ...x402, payTo: opts.resourceId };
  if (opts.url && opts.url.length > 0) card.url = opts.url;
  return JSON.stringify(card);
}

/**
 * Build the FINALIZED agent card for a recovered resource. When the sidecar was already
 * serving a card (AGENT_CARD_JSON present), that exact card is finalized (its placeholder
 * or wrong payTo is stamped to the resourceId - idempotent when already finalized).
 * Otherwise the card is REBUILT from the slug + the recovered pricing. Either way the card's
 * payTo is stamped to the resourceId (the marketplace payTo-binding gate needs this) and its
 * url to the resource base URL.
 */
export function buildRecoveredCard(opts: {
  resource: RecoveredResource;
  slug: string;
  domain: string;
}): RecoveredCard {
  const fromServedCard = Boolean(
    opts.resource.agentCardJson && opts.resource.agentCardJson.trim().length > 0,
  );
  const baseCardJson = fromServedCard
    ? (opts.resource.agentCardJson as string)
    : JSON.stringify(
        buildRecoveredAgentCard(deslugToPrompt(opts.slug), {
          model: "metered",
          // The card's advisory pricing: base/perKB from the sidecar env, and `max` = the
          // real per-call escrow cap (what a buyer signs), which is the meaningful ceiling.
          base: opts.resource.pricing.base,
          perKB: opts.resource.pricing.perKB,
          max: opts.resource.cap.toString(),
        }),
      );

  const cardBaseUrl = `https://${opts.slug}.resources.${opts.domain}`;
  const cardUrl = `${cardBaseUrl}/.well-known/agent-card.json`;
  const finalizedJson = finalizeCardJson(baseCardJson, {
    resourceId: opts.resource.resourceId,
    url: cardBaseUrl,
  });
  return { finalizedJson, cardBaseUrl, cardUrl, fromServedCard };
}

// ---------------------------------------------------------------------------
// The host orchestration (docker + network; not unit-tested end-to-end, mirroring
// orchestrate.ts's live launch paths - the pure pieces above carry the tests).
// ---------------------------------------------------------------------------

/** Read a required env var or throw an operator-friendly, value-free error. */
function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `[recover] missing ${name}. Set it in .env.local (gitignored) on the host, then re-run. ` +
        "See infrastructure/RUNBOOK.md.",
    );
  }
  return v;
}

/** The per-resource outcome of a recovery pass. */
export interface RecoverItem {
  slug: string;
  resourceId?: string;
  status: "planned" | "listed" | "skipped" | "failed";
  detail: string;
}

/** The summary a recovery pass returns (and prints). */
export interface RecoverSummary {
  apply: boolean;
  items: RecoverItem[];
}

/**
 * Resolve a running platform container's host-reachable URL by inspecting a network for a
 * container whose Name contains the hint, then reading its IPv4 (mirrors
 * resolveFacilitatorUrl). Used to reach the marketplace from the HOST process when
 * MARKETPLACE_URL is not explicitly set: the marketplace sits on `upstreamnet` (the
 * egress-enabled, non-internal bridge), so its IP there is reachable from the host.
 */
async function resolveContainerUrl(
  docker: DockerHandle,
  opts: { network: string; port: number; hint: string },
): Promise<string> {
  const dockerApi = docker as unknown as Docker;
  const info = await dockerApi.getNetwork(opts.network).inspect();
  const containers = info.Containers ?? {};
  for (const entry of Object.values(containers)) {
    if (!entry?.Name?.toLowerCase().includes(opts.hint.toLowerCase())) continue;
    const ip = (entry.IPv4Address ?? "").split("/")[0]?.trim();
    if (ip) return `http://${ip}:${opts.port}`;
  }
  throw new Error(
    `resolveContainerUrl: no container matching "${opts.hint}" on network "${opts.network}". ` +
      `Set MARKETPLACE_URL to a host-reachable marketplace URL and re-run.`,
  );
}

/** Poll a URL with GET until it returns 200 (the sidecar is serving the card), or time out. */
async function waitForCard200(
  url: string,
  fetchImpl: typeof fetch,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const intervalMs = opts.intervalMs ?? 3_000;
  for (;;) {
    try {
      const res = await fetchImpl(url, { method: "GET" });
      if (res.status === 200) return true;
    } catch {
      // Boot-window fetch failure (container starting / route not yet hot): retry.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** POST the finalized card to the marketplace publish endpoint. NEVER logs the bearer. */
async function publishToMarketplace(
  opts: {
    marketplaceUrl: string;
    secret: string;
    body: Record<string, unknown>;
  },
  fetchImpl: typeof fetch,
): Promise<{ status: number; listed: boolean; reason?: string }> {
  const url = `${opts.marketplaceUrl.replace(/\/+$/, "")}/resources`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.secret}`, // ONLY here; never logged/echoed.
        "content-type": "application/json",
      },
      body: JSON.stringify(opts.body),
    });
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return {
      status: 0,
      listed: false,
      reason: `marketplace unreachable from host${typeof code === "string" ? ` (${code})` : ""}`,
    };
  }
  let parsed: { listed?: unknown; error?: unknown; reason?: unknown } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // Non-JSON body: the status alone shapes the outcome.
  }
  const reason =
    typeof parsed.reason === "string"
      ? parsed.reason
      : typeof parsed.error === "string"
        ? parsed.error
        : undefined;
  return {
    status: res.status,
    listed: res.status === 201 && parsed.listed === true,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Run the recovery pass. Enumerates every managed SIDECAR container, rebuilds + finalizes
 * each resource's card from the sidecar env, and (when `apply`) hot-swaps the sidecar for
 * the current card-serving build + publishes to the marketplace. DRY-RUN (apply:false)
 * prints the plan and mutates nothing.
 *
 * HOST-GATED: throws off the provisioned host (UTTER_SANDBOX_HOST=1).
 */
export async function recoverResources(opts: {
  apply: boolean;
  fetchImpl?: typeof fetch;
}): Promise<RecoverSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const docker = resolveDockerHandle();
  if (!docker) {
    throw new Error(
      "[recover] must run on the provisioned gVisor host with UTTER_SANDBOX_HOST=1 " +
        "(it inspects + relaunches the sidecar containers under runsc). See infrastructure/RUNBOOK.md.",
    );
  }
  const dockerApi = docker as unknown as Docker;

  const domain = requireEnv("DEPLOY_DOMAIN");
  const rpcUrl = process.env.ARC_RPC_URL; // optional override; chain-default fallback
  const publicClient = createArcPublicClient(rpcUrl);

  // Apply-only context: the publish/facilitator SECRETS + the host-reachable service URLs.
  // Resolved ONLY when applying, so a DRY-RUN runs on a host that cannot reach the
  // marketplace/facilitator and even without those secrets set (it mutates + publishes
  // nothing). A resolution/secret error here would otherwise abort the whole run.
  let applyCtx:
    | {
        facilitatorUrl: string;
        marketplaceUrl: string;
        facilitatorSecret: string;
        marketplaceSecret: string;
      }
    | undefined;
  if (opts.apply) {
    const facilitatorSecret = requireEnv("FACILITATOR_AUTH_SECRET");
    const marketplaceSecret = requireEnv("MARKETPLACE_AUTH_SECRET");
    // The marketplace URL the HOST process POSTs to. An explicit MARKETPLACE_URL wins;
    // otherwise resolve the marketplace container's IP on upstreamnet (host-reachable).
    const marketplaceUrl =
      process.env.MARKETPLACE_URL?.trim() ||
      (await resolveContainerUrl(docker, {
        network: process.env.MARKETPLACE_NETWORK?.trim() || "upstreamnet",
        port: Number(process.env.MARKETPLACE_PORT ?? "8789"),
        hint: "marketplace",
      }));
    // The facilitator URL the RELAUNCHED sidecar POSTs verify/settle/release to (resolved
    // by IP on controlplane, exactly like live-deploy - runsc has no Docker DNS).
    const facilitatorUrl =
      process.env.FACILITATOR_URL?.trim() ||
      (await resolveFacilitatorUrl(docker, {
        network: process.env.FACILITATOR_NETWORK?.trim() || "controlplane",
      }));
    applyCtx = { facilitatorUrl, marketplaceUrl, facilitatorSecret, marketplaceSecret };
  }

  // Enumerate every managed sidecar (role=gate), including stopped ones.
  const sidecarInfos = await dockerApi.listContainers({
    all: true,
    filters: { label: [`${ROLE_LABEL}=${ROLE_GATE}`] },
  });

  const items: RecoverItem[] = [];
  let sidecarImageBuilt = false;

  const ensureSidecarImage = async (): Promise<void> => {
    if (sidecarImageBuilt) return;
    const bundle = await bundleSidecar({
      outDir: join(tmpdir(), "utter-recovery-sidecar-bundle"),
      port: PAIR_PORT,
    });
    const build = await buildResourceImage(bundle.bundleDir, {
      runtime: "node",
      tag: RECOVERY_SIDECAR_IMAGE,
      docker: docker as unknown as Docker,
    });
    if (!build.built) {
      throw new Error(
        `[recover] sidecar image '${RECOVERY_SIDECAR_IMAGE}' was not built (a docker handle ` +
          "was provided, so it must build). Confirm DEPLOY_BASE_IMAGE_NODE is a real digest-pinned base.",
      );
    }
    sidecarImageBuilt = true;
  };

  for (const info of sidecarInfos) {
    const labels = info.Labels ?? {};
    const slug = labels[SLUG_LABEL];
    if (!slug) {
      items.push({ slug: "(unknown)", status: "skipped", detail: "sidecar has no slug label" });
      continue;
    }

    try {
      // (1) Read the sidecar env -> the recovered facts.
      const inspected = await dockerApi.getContainer(info.Id).inspect();
      const envMap = parseEnvArray(inspected.Config?.Env);
      const resource = parseSidecarEnv(envMap);

      // (2) Rebuild + finalize the card (no handler needed for this).
      const { finalizedJson, cardUrl } = buildRecoveredCard({ resource, slug, domain });
      const card = JSON.parse(finalizedJson) as Record<string, unknown>;

      // (3) Read the IMMUTABLE on-chain owner for the dashboard ownership projection
      // (best-effort; the marketplace re-binds it to the same on-chain owner when armed).
      let creator: Hex | undefined;
      try {
        const res = (await publicClient.readContract({
          address: RESOURCE_REGISTRY,
          abi: registryAbi,
          functionName: "getResource",
          args: [resource.resourceId],
        })) as unknown;
        const owner = Array.isArray(res)
          ? (res[0] as unknown)
          : (res as { creator?: unknown }).creator;
        if (typeof owner === "string" && /^0x[0-9a-fA-F]{40}$/.test(owner)) {
          creator = owner as Hex;
        }
      } catch {
        // Unregistered / RPC unreachable: leave creator undefined; the marketplace binds it.
      }

      // (4) Handler state (the sidecar reverse-proxies to it; it must be running to serve).
      const handlerInfos = await dockerApi.listContainers({
        all: true,
        filters: { label: [`${SLUG_LABEL}=${slug}`, `${ROLE_LABEL}=${ROLE_HANDLER}`] },
      });
      const runningHandler = handlerInfos.find((h) => h.State === "running");
      const anyHandler = runningHandler ?? handlerInfos[0];

      const cardSource = resource.agentCardJson ? "served-card" : "reconstructed";

      // DRY-RUN: report the plan, mutate nothing.
      if (!opts.apply) {
        const handlerState = runningHandler
          ? "handler running"
          : anyHandler
            ? "handler stopped (will start on --apply)"
            : "NO handler container (cannot recover)";
        items.push({
          slug,
          resourceId: resource.resourceId,
          status: anyHandler ? "planned" : "skipped",
          detail: `${cardSource} card -> would re-serve + publish (${handlerState}); owner ${creator ?? "(on-chain resolve)"}`,
        });
        continue;
      }

      // APPLY. opts.apply is true here, so applyCtx was resolved during setup.
      const ctx = applyCtx!;

      // Ensure the handler is running so its IP can be inspected + proxied.
      if (!anyHandler) {
        items.push({
          slug,
          resourceId: resource.resourceId,
          status: "skipped",
          detail: "no handler container found; nothing to serve (re-create this one from its prompt)",
        });
        continue;
      }
      if (!runningHandler) {
        try {
          await dockerApi.getContainer(anyHandler.Id).start();
        } catch (err) {
          items.push({
            slug,
            resourceId: resource.resourceId,
            status: "failed",
            detail: `handler was stopped and failed to start: ${(err as Error).message}`,
          });
          continue;
        }
      }

      // Inspect the (now-running) handler's IP on the shared pairnet.
      const pairnet = pairnetName(slug);
      const handlerId = (runningHandler ?? anyHandler).Id;
      const handlerInspected = await dockerApi.getContainer(handlerId).inspect();
      const handlerIp = handlerInspected.NetworkSettings?.Networks?.[pairnet]?.IPAddress?.trim();
      if (!handlerIp) {
        items.push({
          slug,
          resourceId: resource.resourceId,
          status: "failed",
          detail: `could not resolve handler IP on pairnet '${pairnet}'`,
        });
        continue;
      }
      const handlerUrl = `http://${handlerIp}:${PAIR_PORT}`;

      // Build the current card-serving sidecar image once, then re-mint the rid-bound
      // facilitator token (deterministic from the secret; never logged).
      await ensureSidecarImage();
      const facilitatorToken = mintFacilitatorToken({
        resourceId: resource.resourceId,
        secret: ctx.facilitatorSecret,
      });

      // Hot-swap the sidecar: remove the old one (by its stable name) and launch the new
      // card-serving build with the SAME env plus AGENT_CARD_JSON (the finalized card).
      const { sidecarName } = pairNames(slug);
      try {
        await dockerApi.getContainer(sidecarName).remove({ force: true });
      } catch {
        // No prior sidecar (or already gone): nothing to remove.
      }
      const sidecarSpec = buildTrustedServiceSpec({
        backend: "gvisor",
        image: RECOVERY_SIDECAR_IMAGE,
        limits: ECHO_SERVICE.limits,
        network: PAIR_NETWORKS.sidecar,
        extraNetworks: ["controlplane", pairnet],
        env: buildSidecarServiceEnv({
          facilitatorUrl: ctx.facilitatorUrl,
          resourceId: resource.resourceId,
          cap: resource.cap,
          pricing: resource.pricing,
          maxTimeoutSeconds: resource.maxTimeoutSeconds,
          handlerUrl,
          facilitatorToken,
          classifierSchema: resource.classifierSchema,
          freePaths: resource.freePaths,
          agentCard: finalizedJson,
          port: PAIR_PORT,
        }),
        name: sidecarName,
        port: PAIR_PORT,
        labels: {
          [RESOURCE_ID_LABEL]: resource.resourceId,
          [SLUG_LABEL]: slug,
          [ROLE_LABEL]: ROLE_GATE,
        },
      });
      await new GvisorRunner(docker).startService(sidecarSpec);

      // Ensure the Traefik route points at the sidecar (idempotent; restores a lost file).
      await writeTraefikDynamicFile({
        slug,
        domain,
        containerUrl: sidecarContainerUrl(slug),
      });

      // Wait for the card to be served (200) before publishing (the probe fetches it).
      const ready = await waitForCard200(cardUrl, fetchImpl);
      if (!ready) {
        items.push({
          slug,
          resourceId: resource.resourceId,
          status: "failed",
          detail: "sidecar relaunched but card URL did not return 200 in time; re-run --apply to retry publish",
        });
        continue;
      }

      // Publish (the exact same POST a normal deploy runs). creator is the on-chain owner.
      const outcome = await publishToMarketplace(
        {
          marketplaceUrl: ctx.marketplaceUrl,
          secret: ctx.marketplaceSecret,
          body: {
            prompt: deslugToPrompt(slug),
            resourceId: resource.resourceId,
            category: "data",
            card,
            cardUrl,
            slug,
            ...(creator ? { creator } : {}),
          },
        },
        fetchImpl,
      );
      if (outcome.listed) {
        items.push({
          slug,
          resourceId: resource.resourceId,
          status: "listed",
          detail: `re-served (${cardSource}) + published; owner ${creator ?? "(marketplace-bound)"}`,
        });
      } else {
        items.push({
          slug,
          resourceId: resource.resourceId,
          status: "failed",
          detail: `re-served but publish returned ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`,
        });
      }
    } catch (err) {
      items.push({
        slug,
        status: "failed",
        detail: (err as Error).message,
      });
    }
  }

  return { apply: opts.apply, items };
}

/** Print a recovery summary as plain, non-secret lines. */
export function printSummary(summary: RecoverSummary): void {
  const counts = summary.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n[recover] ${summary.apply ? "APPLY" : "DRY-RUN"} - ${summary.items.length} resource(s):`,
  );
  for (const item of summary.items) {
    const idPart = item.resourceId ? ` ${item.resourceId}` : "";
    console.log(`  [${item.status}] ${item.slug}${idPart}: ${item.detail}`);
  }
  console.log(
    `[recover] totals: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "none"}`,
  );
  if (!summary.apply) {
    console.log("[recover] this was a DRY-RUN. Re-run with `--apply` to re-serve + publish.");
  }
}

// Operator entry point: `node src/recover-resources.ts [--apply]`. Default DRY-RUN.
// pathToFileURL normalizes argv[1] to the same href import.meta.url carries (Windows + POSIX).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply");
  recoverResources({ apply })
    .then((summary) => {
      printSummary(summary);
      // A recovery run is advisory: a per-resource failure is reported, not a process error.
      const failed = summary.items.filter((i) => i.status === "failed").length;
      if (apply && failed > 0) process.exitCode = 1;
    })
    .catch((err: unknown) => {
      console.error("[recover] failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
