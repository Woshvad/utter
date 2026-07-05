// live-deploy.ts - the OPERATOR-GATED live HTTPS deploy script (DEP-01/02, PRX-02).
//
// This is the genuine production proof for the deploy plane: it deploys the echo
// bundle behind the real Traefik wildcard-TLS edge and curls the resulting
// `https://<slug>.resources.<domain>` URL, asserting 402 unpaid -> 200 paid over
// real HTTPS, then asserts a non-allowlisted host is unreachable from the
// container (PRX-02). It is OPERATOR-GATED exactly like Phase 2's live-money-path
// (packages/x402-arc/examples/echo/live-money-path.ts): the autonomous suite
// (services/deployer/test/money-path.test.ts) proves the 402->200 LOGIC against an
// in-process facilitator + a mocked chain; THIS script proves the genuine live
// HTTPS path on the provisioned host.
//
// IT IS WRITTEN + COMMITTED + TYPE-CHECKS, NOT EXECUTED in the autonomous phase.
// There is no provisioned gVisor host + no `*.resources.<domain>` wildcard cert in
// the repo, so the live acceptance is recorded as a Deferred Item in STATE.md
// (mirroring Phases 1/2). Run it ONLY after infrastructure/sandbox-host/PROVISION.md
// + the wildcard DNS-01 cert are provisioned, following infrastructure/RUNBOOK.md.
//
// Why a real curl (not an in-process request): the live acceptance proves the
// edge - Traefik wildcard TLS termination + host routing + the in-process x402
// gate behind it - end to end over the public internet, which the in-process test
// cannot. The 402->200 LOGIC is already proven autonomously; this adds the live
// transport + TLS + DNS proof.
//
// SECURITY: keys + DNS credentials are read ONLY from .env.local (gitignored) and
// are NEVER logged.
import { config as loadEnv } from "dotenv";
import type Docker from "dockerode";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  createArcPublicClient,
  createArcWalletClient,
  USDC,
  erc20Abi,
  escrowAbi,
  PAYMENT_ESCROW,
} from "@utter/chain";
import {
  signDebitAuthorization,
  encodePayment,
  computeValidBefore,
  ECHO_RESOURCE_LABEL,
  resourceIdForLabel,
  type Pricing,
  type PaymentPayload,
} from "@utter/x402-arc";
import {
  GvisorRunner,
  buildRunSpec,
  createLiveHostProbe,
  DEFAULT_PROBE_TARGETS,
} from "@utter/sandbox";
import {
  registerResourceIfNeeded,
  type RegistryAdminWriter,
  type RegistryReader,
} from "./register-resource";
import {
  resolveDockerHandle,
  resolveFacilitatorUrl,
  launchResourcePair,
  pairNames,
  pairnetName,
  sidecarContainerUrl,
  writeTraefikDynamicFile,
  waitForUnpaid402,
  type DockerHandle,
} from "./orchestrate";
import { validateSlug } from "./traefik-config";
import {
  GENERATED_BUNDLE_KEYS,
  writeBundleToDir,
} from "./bundle-generated";
import { gateGeneratedBundle } from "./gate-bundle";
import { mintFacilitatorToken } from "./facilitator-token";
// Self-namespace import so deployGeneratedBundle calls deployResource through the module
// binding. That single indirection lets the adversarial gate-before-build test spy on
// deployResource and assert it is called ZERO times when the bundle fails the gate.
import * as self from "./live-deploy";

// `quiet: true` keeps dotenv's stdout "injected env" banner off stdout. This module's
// top-level load fires at IMPORT time, and @utter/deployer is reachable transitively from
// stdio bins (e.g. the buyer MCP server) whose stdout carries JSON-RPC frames - an
// unsilenced banner there would corrupt the channel (Pitfall 1 / T-07-STDOUT). The env is
// still loaded identically; only the banner is suppressed.
//
// Resolve .env.local relative to THIS module (NOT cwd), mirroring orchestrate.ts's
// defaultDynamicDir: src/live-deploy.ts -> ../../../.env.local (the repo root). The
// operator may run this from the repo root OR from services/deployer (the RUNBOOK
// shows both); a cwd-relative path only worked from the repo root and otherwise
// failed with a misleading "missing DEPLOY_DOMAIN". The module-relative path makes
// both cwd forms load the same repo-root env.
loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env.local"),
  quiet: true,
});

/** The deterministic resource id + slug for the live echo deploy. The id derives
 * from the shared @utter/x402-arc helper so the register/payTo id, the resource
 * RESOURCE_ID env, and the studio all agree (single source of truth). */
const RESOURCE_ID: Hex = resourceIdForLabel(ECHO_RESOURCE_LABEL);
const SLUG = process.env.DEPLOY_SLUG?.trim() || "echo";
const MAX_TIMEOUT_SECONDS = Number(process.env.RESOURCE_TIMEOUT_SECONDS ?? "30");
const SETTLE_BUFFER_SECONDS = Number(process.env.SETTLE_BUFFER_SECONDS ?? "90");
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: Number(process.env.MAX_RESPONSE_BYTES ?? "1048576"),
};

/**
 * The echo response schema the sidecar's classifier compiles (declared-errors stay
 * free through the gate). Read module-relative (NOT cwd, mirroring orchestrate's
 * defaultDynamicDir): src/live-deploy.ts -> ../../../packages/x402-arc/examples/echo.
 * It is non-secret (the public success/declared-error shape), safe to pass into the
 * sidecar env. Read lazily inside liveDeployEcho so a missing file fails at deploy
 * time, not at import (the autonomous suite imports this module).
 */
const ECHO_OPENAPI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/x402-arc/examples/echo/openapi.json",
);

/** The result of the live HTTPS acceptance (returned for the runbook to record). */
export interface LiveDeployResult {
  /** The live HTTPS URL the echo bundle was deployed at. */
  url: string;
  /** The unpaid status (asserted 402). */
  unpaidStatus: number;
  /** The paid status (asserted 200). */
  paidStatus: number;
  /** Whether a non-allowlisted host was confirmed unreachable from the container (PRX-02). */
  nonAllowlistedUnreachable: boolean;
  /** The on-chain registration tx (present only when this run registered the
   * resource; absent when the resourceId was already active). */
  registrationTx?: Hex;
  /** True when the resourceId was already registered + active before this run
   * (registration was a no-op; the redeploy idempotency path). */
  alreadyActive: boolean;
  /** The on-chain settle tx hash (from the X-PAYMENT-RESPONSE receipt). */
  settleTx?: Hex;
  /** The debited amount in USDC base units (from the on-chain Debited event). */
  debitAmount?: string;
  /** The creator's share of the debit (USDC base units, on-chain Debited). */
  toCreator?: string;
  /** The treasury's share of the debit (USDC base units, on-chain Debited). */
  toTreasury?: string;
}

/**
 * A single step-boundary progress event emitted during a {@link deployResource} run.
 *
 * It carries the deploy phase, a running/ok/error status, and a plain-prose,
 * NON-SECRET message describing the step state. The terminal `done` event also
 * carries the {@link LiveDeployResult}. No message ever interpolates a key, token,
 * facilitator secret, or any other credential; it is safe to stream to an
 * authenticated caller (the SSE seam increment B consumes).
 */
export interface DeployProgressEvent {
  /** The deploy step this event reports on. */
  phase: "register" | "build" | "launch" | "route" | "verify" | "probe" | "done" | "error";
  /** Whether the step is starting, succeeded, or failed. */
  status: "running" | "ok" | "error";
  /** A plain-prose, NON-SECRET description of the step state. */
  message: string;
  /** Present only on the terminal `done` event: the deploy result. */
  result?: LiveDeployResult;
}

/**
 * The trusted control-plane spec a {@link deployResource} run is driven by.
 *
 * resourceId, slug, pricing, and maxTimeoutSeconds are TRUSTED operator/control-plane
 * inputs - they NEVER come from an untrusted generated bundle. classifierSchema is the
 * openapi the sidecar classifies declared-errors against (the ONE field a generated
 * deploy reads FROM its bundle). handlerBundleDir (optional) is the ALREADY-GATED
 * generated bundle dir the handler image is built from; absent, the echo gate-less
 * handler is bundled.
 */
export interface DeployResourceSpec {
  /** The resource being charged (bytes32 Hex) - the escrow payTo. TRUSTED. */
  resourceId: Hex;
  /** The resource slug; derives the container names + the Traefik route. TRUSTED. */
  slug: string;
  /** The per-resource metered pricing terms. TRUSTED. */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). TRUSTED. */
  maxTimeoutSeconds: number;
  /** The JSON response schema the sidecar classifies against (the one bundle-sourced field). */
  classifierSchema: string;
  /** The EXACT discovery routes the sidecar bypasses the gate on (FREE_PATHS). */
  freePaths: string[];
  /** The ALREADY-GATED generated bundle dir for the handler image (absent -> echo handler). */
  handlerBundleDir?: string;
  /**
   * The handler's DECLARED success input (the same input G4 replays to get 200), used as
   * the paid smoke-test body so a handler that validates its input passes the deploy
   * check the same way it passed G4. Absent -> the generic echo body `{ text: "live" }`.
   * TRUSTED-shaped: it is a declared-safe value from the already-gated bundle's
   * test-cases.json (G1/G2 scanned), never an arbitrary untrusted string.
   */
  successInput?: unknown;
}

/**
 * Select the handler's DECLARED success INPUT from a bundle's test-cases.json - the same
 * input G4 (packages/ai-runtime validate.ts gateServeBehindX402) replays to get 200. The
 * deploy paid smoke test uses it so a handler with input validation (e.g. a required
 * `repeat` positive integer) passes the live paid call the same way it passed G4, instead
 * of 400-ing on the generic `{ text: "live" }` echo body. Mirrors G4 exactly: find the
 * first case with expectedClass "success", return its `input` (or `{}` when the case
 * declares no input). Returns undefined for no bundle / no success case / a parse error,
 * so the caller falls back to the echo body. Exported for a unit test.
 */
export function selectDeclaredSuccessInput(testCasesJson: string | undefined): unknown {
  if (!testCasesJson) return undefined;
  try {
    const parsed = JSON.parse(testCasesJson) as {
      cases?: Array<{ expectedClass?: string; input?: unknown }>;
    };
    if (!Array.isArray(parsed.cases)) return undefined;
    const success = parsed.cases.find((c) => c.expectedClass === "success");
    if (!success) return undefined;
    return success.input ?? {};
  } catch {
    return undefined;
  }
}

/** Read a required env var or throw an operator-friendly error (never logs the value). */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `[live-deploy] missing ${name}. Provision the host + the *.resources.<domain> ` +
        `wildcard cert (infrastructure/sandbox-host/PROVISION.md), then set ${name} in ` +
        `.env.local (gitignored). See infrastructure/RUNBOOK.md.`,
    );
  }
  return value;
}

/** A 0x-prefixed bytes32 random nonce (the idemKey for this live call). */
function randomNonce(): Hex {
  // Use the explicitly-imported webcrypto (IN-04) rather than assuming a global
  // `crypto`, so the operator script does not throw at nonce generation on a
  // runtime where `globalThis.crypto` is absent.
  const bytes = webcrypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

/**
 * Run the operator-gated live HTTPS deploy + acceptance.
 *
 * Steps (operator, on the provisioned host, per infrastructure/RUNBOOK.md):
 *   0. Read DEPLOY_DOMAIN + the funded buyer key + the facilitator URL from .env.local.
 *   1. Generate the per-resource Traefik dynamic config for `<slug>.resources.<domain>`
 *      and confirm it is written to infrastructure/traefik/dynamic/ (the file provider
 *      hot-loads it; the wildcard cert is operator-provisioned via DNS-01).
 *   2. curl `https://<slug>.resources.<domain>/echo` with NO X-PAYMENT -> assert 402.
 *   3. Sign a real DebitAuthorization, curl with X-PAYMENT -> assert 200 over HTTPS.
 *   4. Attempt a non-allowlisted host from inside the container -> assert unreachable (PRX-02).
 *
 * This function is the operator entry point. It is NEVER invoked by the autonomous
 * suite (no provisioned host / cert), so it is exported but not auto-run on import.
 *
 * It now delegates to {@link deployResource}: it resolves the docker handle, applies
 * the host-gate throw, builds the echo spec from the module constants (NO
 * handlerBundleDir), and runs the generic deploy core. Its observable behavior is
 * identical to before this extraction.
 */
export async function liveDeployEcho(
  fetchImpl: typeof fetch = fetch,
): Promise<LiveDeployResult> {
  // Resolve docker + apply the host gate BEFORE any on-chain step (it now fires here in
  // the wrapper, not deep in the body): off-host this fails fast before gas. The echo
  // spec is built from the trusted module constants - NO handlerBundleDir (the echo
  // handler is bundled). classifierSchema is the public echo openapi (declared-errors
  // free). Then delegate to the generic deploy core.
  const docker: DockerHandle | undefined = resolveDockerHandle();
  if (!docker) {
    throw new Error(
      "[live-deploy] must run on the provisioned gVisor host with UTTER_SANDBOX_HOST=1 " +
        "(it builds + runs the sidecar+handler pair under runsc). See infrastructure/RUNBOOK.md.",
    );
  }
  const echoSpec: DeployResourceSpec = {
    resourceId: RESOURCE_ID,
    slug: SLUG,
    pricing: PRICING,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    classifierSchema: readFileSync(ECHO_OPENAPI_PATH, "utf8"),
    // The echo's ONLY free route is its A2A discovery card; everything else is gated.
    freePaths: ["/.well-known/agent-card.json"],
  };
  // Pass NO opts: the echo wrapper's observable behavior + every console.log stay
  // byte-for-byte unchanged (the off-progress path is a no-op).
  return deployResource(docker, echoSpec, fetchImpl);
}

/**
 * The generic live HTTPS deploy core (the former liveDeployEcho body, now parameterized).
 *
 * It takes a resolved docker handle + a TRUSTED {@link DeployResourceSpec} + a fetch
 * impl and runs the full deploy: ensure the buyer's escrow deposit, register the
 * resource on-chain, build+run the sidecar+handler pair (threading spec.handlerBundleDir
 * into launchResourcePair only when present), write the Traefik route, prove
 * 402(unpaid)->200(paid) over HTTPS, verify the on-chain Debited split, and run the
 * PRX-02 egress probe. Returns the same LiveDeployResult shape.
 *
 * The host gate lives in the WRAPPERS (liveDeployEcho / deployGeneratedBundle): this
 * core assumes a live docker handle. It is NEVER run end-to-end by the autonomous suite.
 */
export async function deployResource(
  docker: DockerHandle,
  spec: DeployResourceSpec,
  fetchImpl: typeof fetch = fetch,
  opts?: { onProgress?: (e: DeployProgressEvent) => void },
): Promise<LiveDeployResult> {
  // An absent callback makes every emit below a no-op, so the off-progress path
  // (liveDeployEcho passes no opts) is observably unchanged.
  const emit = (e: DeployProgressEvent): void => opts?.onProgress?.(e);
  // (0) Operator inputs from .env.local ONLY. DEPLOY_DOMAIN + the buyer key are
  // REQUIRED (requireEnv fails closed with an operator-friendly error). ARC_RPC_URL
  // is deliberately OPTIONAL (WR-07): createArcPublicClient/createArcWalletClient
  // fall back to the chain's default HTTP RPC when it is absent or blank, so we do
  // NOT route it through requireEnv — it is an explicit override, not a hard
  // requirement.
  const domain = requireEnv("DEPLOY_DOMAIN");
  const buyerKey = requireEnv("TEST_BUYER_PRIVATE_KEY") as Hex;
  const rpcUrl = process.env.ARC_RPC_URL; // optional override; chain-default fallback

  // The facilitator caller-auth secret (C1) the sidecar's token is minted from. NEW
  // required input for the sidecar topology: the trusted sidecar presents a per-
  // resource Bearer token to the facilitator. A short/blank secret fails fast in
  // mintFacilitatorToken (>=32 chars). Read here, passed into the mint; NEVER logged.
  const facilitatorAuthSecret = requireEnv("FACILITATOR_AUTH_SECRET");

  // Registration inputs from .env.local ONLY. REGISTRY_ADMIN_PRIVATE_KEY is the
  // registry Ownable owner (register is onlyOwner); PLATFORM_TREASURY is the
  // platform split recipient. creatorBps is a RATIO (10000 - PLATFORM_FEE_BPS),
  // never an amount; PLATFORM_FEE_BPS defaults to 3000 so creatorBps = 7000 (the
  // proven 70/30 split). creator defaults to the admin address unless an explicit
  // RESOURCE_CREATOR override is set. Keys are read here and passed into the
  // injected admin wallet below; they are NEVER logged.
  const adminKey = requireEnv("REGISTRY_ADMIN_PRIVATE_KEY") as Hex;
  const treasury = requireEnv("PLATFORM_TREASURY") as Address;
  const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? "3000");
  const creatorBps = 10_000 - platformFeeBps; // a ratio against 10000, NOT an amount

  const publicClient = createArcPublicClient(rpcUrl) as PublicClient;
  const buyerAccount = privateKeyToAccount(buyerKey);
  const buyer: Address = buyerAccount.address;
  const buyerWallet = createArcWalletClient(buyerAccount, rpcUrl);

  // Sanity: confirm we are on Arc Testnet before signing anything chargeable.
  const chainId = await publicClient.getChainId();
  if (chainId !== arcTestnet.id) {
    throw new Error(`[live-deploy] wrong chain ${chainId}, expected ${arcTestnet.id} (Arc Testnet)`);
  }

  // Read USDC decimals at runtime (never hardcode) to derive the cap.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  const cap = 10n ** BigInt(decimals) / 100n; // 0.01 USDC

  // (0a) ENSURE the buyer's escrow balance >= cap (money-critical). The gate's
  // /verify checks balanceOf(buyer) >= cap on-chain; without a funded deposit the
  // paid call reverts at /settle. This replicates the PROVEN flow from
  // packages/x402-arc/examples/echo/live-money-path.ts: read balanceOf(buyer) on
  // PAYMENT_ESCROW and deposit(need) if short. PaymentEscrow.deposit() pulls USDC
  // via safeTransferFrom (read of the contract), so it REQUIRES a prior ERC-20
  // approve - the proven live run did a separate `approve USDC` tx before deposit
  // (contracts/DEPLOYMENTS.md). We add a GUARDED approve: read allowance first and
  // approve only when it is short, so a re-run with standing allowance skips it. We
  // log amounts only, never a key.
  const escrowBalance = (await publicClient.readContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;
  if (escrowBalance < cap) {
    const need = cap - escrowBalance;
    // Guarded approve: deposit() calls usdc.safeTransferFrom(msg.sender, ...), which
    // needs allowance(buyer, PAYMENT_ESCROW) >= need. Approve only when short.
    const allowance = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [buyer, PAYMENT_ESCROW],
    })) as bigint;
    if (allowance < need) {
      console.log(`[live-deploy] approving ${need} base units of USDC to PaymentEscrow...`);
      const approveTx = await buyerWallet.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [PAYMENT_ESCROW, need],
        account: buyerAccount,
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      console.log(`[live-deploy] approve confirmed (tx ${approveTx})`);
    }
    console.log(`[live-deploy] depositing ${need} base units into PaymentEscrow...`);
    const depositTx = await buyerWallet.writeContract({
      address: PAYMENT_ESCROW,
      abi: escrowAbi,
      functionName: "deposit",
      args: [need],
      account: buyerAccount,
      chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log(`[live-deploy] deposit confirmed (tx ${depositTx})`);
  } else {
    console.log(`[live-deploy] buyer escrow balance ${escrowBalance} >= cap ${cap} (no deposit needed)`);
  }

  // (0b) Register the resource on-chain BEFORE any debit can fire. The same keccak
  // RESOURCE_ID the quote advertises as payTo must be registered + active, or
  // PaymentEscrow.debit reverts ResourceInactive (design §5.1/§5.3). The admin
  // wallet is built here from the operator key and injected into the helper, which
  // never reads a key itself. creator defaults to the admin address unless
  // RESOURCE_CREATOR overrides it (the creator/admin/treasury roles may collapse on
  // testnet). The step is idempotent: a redeploy of the same label is a no-op.
  emit({ phase: "register", status: "running", message: "registering the resource on-chain" });
  const adminAccount = privateKeyToAccount(adminKey);
  const adminWallet = createArcWalletClient(adminAccount, rpcUrl);
  const creator = (process.env.RESOURCE_CREATOR?.trim() || adminAccount.address) as Address;
  // The helper takes a deliberately narrow structural admin/reader surface (abi:
  // unknown) so it stays chain-agnostic and spy-testable; the real viem clients
  // satisfy it at runtime. Adapt them at this single boundary (the same cast the
  // staking slash path uses for its injected admin client).
  const registration = await registerResourceIfNeeded(
    {
      admin: adminWallet as unknown as RegistryAdminWriter,
      reader: publicClient as unknown as RegistryReader,
    },
    { resourceId: spec.resourceId, creator, treasury, creatorBps },
  );
  if (registration.registered) {
    console.log(`[live-deploy] registered resource ${spec.resourceId} (tx ${registration.registrationTx})`);
  } else if (registration.alreadyActive) {
    console.log(`[live-deploy] resource ${spec.resourceId} already active (registration skipped, idempotent redeploy)`);
  } else if (registration.registeredButPaused) {
    console.warn(
      `[live-deploy] resource ${spec.resourceId} is registered but PAUSED; not auto-unpausing. ` +
        "Unpause it via the registry owner before expecting a debit to succeed.",
    );
  }
  // Note registered vs already-active without ever naming a key or tx secret.
  emit({
    phase: "register",
    status: "ok",
    message: registration.alreadyActive
      ? "resource already active on-chain (registration skipped)"
      : "resource registered on-chain",
  });

  // (0c) BUILD + RUN the sidecar+handler PAIR as hardened runsc services. This is
  // the genuine launch the curl needs: without the running containers the URL serves
  // nothing. The host gate (UTTER_SANDBOX_HOST=1) already ran in the WRAPPER before any
  // on-chain step, so `docker` here is a live handle.
  //
  // NOTE: the pair's live path now REQUIRES wave BD's six-network compose to be
  // applied on the host first - the default proxynet/ingress/controlplane networks
  // must exist or the launch (and the post-create extra-net attach) fail. Apply BD,
  // then run this; see infrastructure/RUNBOOK.md.
  //
  // Resolve the facilitator URL the SIDECAR (only) will POST verify/settle/release
  // to. An explicit FACILITATOR_URL env override still wins (a non-default deploy);
  // otherwise we auto-resolve the facilitator's on-network IP. The IP (not the name)
  // is mandatory because the sidecar runs under runsc, which cannot use Docker's
  // embedded DNS at 127.0.0.11 (the name `facilitator` would EAI_AGAIN inside the
  // container). The resolved value is a non-secret IP:port, safe to log. The handler
  // never sees this value.
  //
  // The six-net topology puts the facilitator on the `controlplane` network (the same
  // network the sidecar joins as an extra to reach it), so that is the default network
  // we inspect. `utter_appnet` was the legacy single-container default and is no longer
  // where the facilitator lives. FACILITATOR_NETWORK overrides the network we inspect;
  // FACILITATOR_URL overrides the whole resolution.
  emit({ phase: "build", status: "running", message: "building the handler + sidecar images" });
  emit({ phase: "launch", status: "running", message: "launching the sidecar+handler pair under runsc" });
  const facilitatorNetwork = process.env.FACILITATOR_NETWORK?.trim() || "controlplane";
  const facilitatorUrl =
    process.env.FACILITATOR_URL?.trim() ||
    (await resolveFacilitatorUrl(docker, { network: facilitatorNetwork }));
  console.log(`[live-deploy] facilitator resolved to ${facilitatorUrl}`);

  // Mint the per-resource caller-auth token the SIDECAR presents to the facilitator
  // (C1). It is bound to spec.resourceId; the untrusted handler NEVER receives it. NEVER
  // logged. The classifier schema comes from the spec (the public openapi the sidecar
  // classifies declared-errors against - the one bundle-sourced field for a generated
  // deploy; the echo wrapper reads the echo openapi).
  const facilitatorToken = mintFacilitatorToken({
    resourceId: spec.resourceId,
    secret: facilitatorAuthSecret,
  });
  const classifierSchema = spec.classifierSchema;

  const { handlerName, sidecarName } = pairNames(spec.slug);
  const launched = await launchResourcePair(docker, {
    resourceId: spec.resourceId,
    slug: spec.slug,
    cap,
    pricing: spec.pricing,
    maxTimeoutSeconds: spec.maxTimeoutSeconds,
    facilitatorUrl,
    facilitatorToken,
    classifierSchema,
    // The free routes the sidecar bypasses the gate on (spec-driven; the echo wrapper
    // passes only the A2A discovery card). pricing.maxResponseBytes flows via `pricing`,
    // so fix F2's MAX_RESPONSE_BYTES reaches the sidecar's metering + bounded proxy read.
    freePaths: spec.freePaths,
    // Build the handler image from the ALREADY-GATED generated bundle dir when present;
    // absent, launchResourcePair bundles the echo gate-less handler (back-compat).
    ...(spec.handlerBundleDir ? { handlerBundleDir: spec.handlerBundleDir } : {}),
  });
  console.log(
    `[live-deploy] pair running under runsc: handler ${handlerName} (image ` +
      `${launched.handlerImage}), sidecar ${sidecarName} (image ${launched.sidecarImage})`,
  );
  emit({ phase: "launch", status: "ok", message: "sidecar+handler pair running under runsc" });

  // (1) WRITE the live Traefik route to disk (atomically) so the file provider
  // hot-loads a router for Host(<slug>.resources.<domain>) -> the SIDECAR container.
  // The wildcard cert is DNS-01-provisioned. The slug.apex host is the URL. Traefik
  // points at the sidecar (not the handler): the 402->200 flows Traefik -> sidecar
  // -> handler, and the sidecar serves /echo and proxies it to the gate-less handler.
  const apex = `resources.${domain}`;
  const url = `https://${spec.slug}.${apex}/echo`;
  const routePath = await writeTraefikDynamicFile({
    slug: spec.slug,
    domain,
    containerUrl: sidecarContainerUrl(spec.slug),
  });
  console.log(`[live-deploy] deploying echo at ${url} (Traefik route written to ${routePath})`);
  emit({ phase: "route", status: "ok", message: "Traefik route written for the resource host" });

  // Replay the handler's DECLARED success input (what G4 validated to 200) as the paid
  // smoke-test body, so a generated handler that validates its input passes the live paid
  // call. Echo (no bundle -> no successInput) keeps the generic `{ text: "live" }` body.
  // The unpaid 402 check below uses its own body: the escrow gate returns 402 BEFORE the
  // handler runs, so any body triggers it - only the paid call reaches the handler.
  const reqInit = {
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify(spec.successInput ?? { text: "live" }),
  };

  // (2) Unpaid call over HTTPS -> expect 402 with the accepts quote. Poll until the
  // paywall is live: a fresh deploy needs the container to boot + the first-time
  // ACME wildcard cert to issue, during which the URL transiently throws/404s/502s.
  emit({ phase: "verify", status: "running", message: "verifying the live 402(unpaid)->200(paid) paywall" });
  const unpaid = await waitForUnpaid402(url, fetchImpl);
  // Belt-and-braces: waitForUnpaid402 only resolves on a real 402, but keep the
  // explicit assertion so the contract is obvious at the call site.
  if (unpaid.status !== 402) {
    throw new Error(`[live-deploy] expected 402 on the unpaid HTTPS call, got ${unpaid.status}`);
  }
  console.log("[live-deploy] unpaid HTTPS call returned 402 (accepts advertised)");

  // (3) Sign a real DebitAuthorization under the locked UtterEscrow/1 domain and
  // re-call with X-PAYMENT -> expect 200 over HTTPS (the live paywall releases).
  const nonce = randomNonce();
  const validBefore = computeValidBefore(spec.maxTimeoutSeconds, SETTLE_BUFFER_SECONDS);
  const signed = await signDebitAuthorization(buyerWallet, {
    buyer,
    resourceId: spec.resourceId,
    maxAmount: cap,
    nonce,
    validBefore,
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "utter-escrow",
    network: "eip155:5042002",
    authorization: {
      buyer,
      resourceId: spec.resourceId,
      maxAmount: cap.toString(),
      nonce,
      validBefore: validBefore.toString(),
    },
    signature: signed.signature,
  };
  const header = encodePayment(payload);

  const paid = await fetchImpl(url, {
    ...reqInit,
    headers: { ...reqInit.headers, "X-PAYMENT": header },
  });
  if (paid.status !== 200) {
    throw new Error(`[live-deploy] expected 200 on the paid HTTPS call, got ${paid.status}: ${await paid.text()}`);
  }
  const receiptHeader = paid.headers.get("X-PAYMENT-RESPONSE");
  if (!receiptHeader) {
    throw new Error("[live-deploy] paid 200 missing X-PAYMENT-RESPONSE receipt header");
  }
  console.log("[live-deploy] paid HTTPS call returned 200 with the receipt (paywall holds in production)");

  // (3a) Surface + VERIFY the on-chain settle. The 200 proves the gate released, but
  // the genuine money proof is the Debited event the settle tx emitted. Reuse the
  // PROVEN shape from packages/x402-arc/examples/echo/live-money-path.ts: decode the
  // base64 X-PAYMENT-RESPONSE -> { tx, amount }, read the receipt, find the Debited
  // log on PAYMENT_ESCROW, and ASSERT the cap + the configured split. A failed
  // assertion THROWS (a real failure). Amounts are non-secret and safe to log; a key
  // is never logged.
  const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as {
    tx: Hex;
    amount: string;
  };
  console.log(`[live-deploy] settle tx ${receipt.tx}`);
  console.log(`[live-deploy] ArcScan: ${arcTestnet.blockExplorers?.default.url}/tx/${receipt.tx}`);

  const txReceipt = await publicClient.getTransactionReceipt({ hash: receipt.tx });
  const debited = txReceipt.logs
    .filter((l) => l.address.toLowerCase() === PAYMENT_ESCROW.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: escrowAbi, data: l.data, topics: l.topics }) as {
          eventName: string;
          args: Record<string, unknown>;
        };
      } catch {
        return null;
      }
    })
    .find((d) => d?.eventName === "Debited");
  if (!debited) {
    throw new Error(`[live-deploy] no Debited event found in the settle tx ${receipt.tx}`);
  }

  const debitAmount = debited.args.amount as bigint;
  const toCreator = debited.args.toCreator as bigint;
  const toTreasury = debited.args.toTreasury as bigint;
  if (debitAmount > cap) {
    throw new Error(`[live-deploy] debit ${debitAmount} exceeds cap ${cap}`);
  }
  if (toCreator + toTreasury !== debitAmount) {
    throw new Error(`[live-deploy] split ${toCreator}+${toTreasury} != amount ${debitAmount}`);
  }
  // The split is a RATIO check, not a literal: treasury == floor(amount * platformFeeBps
  // / 10000), using the SAME platformFeeBps this run derived creatorBps from. Never a
  // hardcoded 3000 - the bps is the single source of truth for the split.
  const expectedTreasury = (debitAmount * BigInt(platformFeeBps)) / 10_000n;
  if (toTreasury !== expectedTreasury) {
    throw new Error(
      `[live-deploy] treasury cut ${toTreasury} != expected ${expectedTreasury} ` +
        `(platformFeeBps ${platformFeeBps})`,
    );
  }
  console.log(
    `[live-deploy] on-chain Debited verified: debit ${debitAmount} <= cap ${cap}; ` +
      `creator ${toCreator} / treasury ${toTreasury} (platformFeeBps ${platformFeeBps}) split holds.`,
  );
  emit({ phase: "verify", status: "ok", message: "paywall verified: 402 unpaid, 200 paid, on-chain split holds" });

  // (4) PRX-02: confirm a non-allowlisted host is unreachable from inside the
  // gVisor container netns, using the REAL blocked-host probe-runner the RUNBOOK
  // documents (createLiveHostProbe + assertBlocked). In PHASE 1 (trusted echo, in-
  // process gate) this is GATED OFF by default: the blocked-host probe image is not
  // built yet, and the full PRX-02 enforcement lands with the Phase 2 nftables
  // increment. It runs ONLY when UTTER_RUN_EGRESS_PROBE=1; otherwise it SKIPS with a
  // clear log and reports unreachable=false (a skip, NOT a false pass), so a missing
  // probe image can never break the live 402->200 proof.
  let nonAllowlistedUnreachable = false;
  if (process.env.UTTER_RUN_EGRESS_PROBE === "1") {
    // Thread the handler's PAIRNET name: the probe attaches to the same internal
    // (no-gateway) bridge as the handler, so the connect tests the HANDLER's real
    // reachability of a blocked host. This is runtime-agnostic (works whether the
    // handler runs under runc or runsc); it does NOT share the handler's netns,
    // which a runc probe cannot reliably observe across a runsc userspace netstack.
    nonAllowlistedUnreachable = await runEgressProbe(docker, pairnetName(spec.slug));
  } else {
    console.log(
      "[live-deploy] PRX-02 SKIPPED (Phase 1): set UTTER_RUN_EGRESS_PROBE=1 to run the " +
        "blocked-host probe. The full egress enforcement lands with the Phase 2 nftables " +
        "increment; recorded as a skip, NOT a pass.",
    );
  }
  emit({
    phase: "probe",
    status: "ok",
    message: nonAllowlistedUnreachable
      ? "PRX-02 egress probe ran: every blocked host unreachable"
      : "PRX-02 egress probe skipped (operator-gated; recorded as a skip, not a pass)",
  });

  const result: LiveDeployResult = {
    url,
    unpaidStatus: unpaid.status,
    paidStatus: paid.status,
    nonAllowlistedUnreachable,
    registrationTx: registration.registrationTx,
    alreadyActive: registration.alreadyActive,
    settleTx: receipt.tx,
    debitAmount: debitAmount.toString(),
    toCreator: toCreator.toString(),
    toTreasury: toTreasury.toString(),
  };
  emit({ phase: "done", status: "ok", message: "deploy complete", result });
  return result;
}

/**
 * Deploy a GENERATED (untrusted) bundle from an on-disk dir through the same proven
 * deploy core liveDeployEcho uses.
 *
 * SECURITY (untrusted-code handling):
 *   1. Load the on-disk bundle into an in-memory Record.
 *   2. GATE FIRST, FAIL CLOSED: run gateGeneratedBundle over the in-memory bundle BEFORE
 *      any write or build. A violation throws BundleGateError and stops here (zero
 *      downstream writeBundleToDir / deployResource calls).
 *   3. Build the TRUSTED control-plane spec: slug / on-chain resourceId / pricing come
 *      from operator ENV, NEVER from the untrusted bundle. ONLY openapi.json is read FROM
 *      the bundle (the classifier schema). The handler stays gate-less + token-less
 *      (deployResource -> launchResourcePair builds buildResourceServiceSpec for the
 *      handler; the trusted sidecar alone holds FACILITATOR_URL + the rid-bound token).
 *   4. Write the bundle to a fresh work dir and hand it to deployResource as the
 *      handlerBundleDir (bundleGeneratedHandler re-gates it structurally before esbuild).
 *
 * It is HOST-GATED exactly like liveDeployEcho (UTTER_SANDBOX_HOST=1) and is NEVER run
 * end-to-end by the autonomous suite. deployResource is called through the module
 * namespace (`self.deployResource`) so the adversarial test can assert it is NOT reached
 * when the gate rejects the bundle.
 */
export async function deployGeneratedBundle(
  bundlePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveDeployResult> {
  // (1) Load the on-disk bundle into an in-memory Record. Only GENERATED_BUNDLE_KEYS are
  // read; a per-key ENOENT is swallowed (an absent optional file is fine). handler.ts is
  // REQUIRED to bundle: a missing/empty one throws a clear error naming the path.
  const bundle: Record<string, string> = {};
  for (const key of GENERATED_BUNDLE_KEYS) {
    try {
      bundle[key] = readFileSync(join(bundlePath, key), "utf8");
    } catch {
      // ENOENT (or another read miss) for an optional key: skip it.
    }
  }
  const handler = bundle["handler.ts"];
  if (!handler || handler.trim().length === 0) {
    throw new Error(
      `[live-deploy] generated bundle at '${bundlePath}' is missing handler.ts (required to deploy).`,
    );
  }

  // (2) Derive the TRUSTED control-plane params from operator ENV (NOT the bundle):
  // slug / resourceId / pricing are operator inputs; ONLY openapi.json is read FROM the
  // bundle (the classifier schema). validateSlug rejects a path-traversing / non-dns slug.
  const slug = validateSlug(requireEnv("DEPLOY_SLUG"));
  const resourceId = resourceIdForLabel(process.env.DEPLOY_RESOURCE_LABEL?.trim() || slug);
  // A generated bundle without an openapi still deploys with a permissive empty-paths
  // classifier; we do NOT read any other bundle file as control-plane input.
  const bundleOpenapi = bundle["openapi.json"];
  const classifierSchema =
    bundleOpenapi && bundleOpenapi.trim().length > 0
      ? bundleOpenapi
      : JSON.stringify({ openapi: "3.1.0", paths: {} });

  // (3) Delegate to deployGatedBundle: it gates the in-memory bundle FIRST (fail closed,
  // before any write or build), writes a work dir, host-gates docker, and runs the deploy
  // core. The gate-before-write/build ordering + behavior stay identical to before this
  // extraction (live-deploy.test.ts (a) + the bundle-generated structural test stay green).
  return deployGatedBundle(
    {
      bundle,
      resourceId,
      slug,
      // Reuse the SAME PRICING the echo path uses (TRUSTED operator input, never the
      // bundle's choosing).
      pricing: PRICING,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      freePaths: ["/.well-known/agent-card.json"],
      classifierSchema,
    },
    fetchImpl,
  );
}

/**
 * The trusted params a {@link deployGatedBundle} run is driven by.
 *
 * resourceId / slug / pricing / maxTimeoutSeconds / freePaths are TRUSTED control-plane
 * inputs (from the authenticated request, NEVER the untrusted bundle). classifierSchema is
 * the one bundle-sourced field (its openapi). `bundle` is the in-memory generated bundle
 * the gate runs over before any write or build.
 */
export interface DeployGatedBundleParams {
  /** The in-memory generated (untrusted) bundle: POSIX-key -> file contents. */
  bundle: Record<string, string>;
  /** The on-chain resource id (bytes32 Hex). TRUSTED. */
  resourceId: Hex;
  /** The resource slug. TRUSTED. */
  slug: string;
  /** The per-resource metered pricing. TRUSTED. */
  pricing: Pricing;
  /** Max handler runtime before the gate times out (seconds). TRUSTED. */
  maxTimeoutSeconds: number;
  /** The free routes the sidecar bypasses the gate on. TRUSTED. */
  freePaths: string[];
  /** The JSON response schema the sidecar classifies against (the one bundle-sourced field). */
  classifierSchema: string;
}

/**
 * Gate, then deploy a GENERATED (untrusted) in-memory bundle through the same proven
 * deploy core liveDeployEcho uses. This is the shared helper deployGeneratedBundle (the
 * ENV/disk path) and the increment B SSE seam both call.
 *
 * SECURITY (untrusted-code handling), IN THIS ORDER:
 *   1. GATE FIRST, FAIL CLOSED: run gateGeneratedBundle over the in-memory bundle BEFORE
 *      any write or build. A violation throws BundleGateError and stops here (zero
 *      downstream writeBundleToDir / deployResource calls).
 *   2. Write the bundle to a fresh work dir.
 *   3. Host-gate docker (UTTER_SANDBOX_HOST=1) exactly like liveDeployEcho.
 *   4. Run the deploy core with the work dir as the handlerBundleDir, forwarding the
 *      progress opts. slug / resourceId / pricing come ONLY from params (the authenticated
 *      caller's choosing); ONLY the bundle's openapi is read (classifierSchema).
 *
 * deployResource is called through the module namespace (`self.deployResource`) so the
 * adversarial test can assert it is NOT reached when the gate rejects the bundle.
 */
export async function deployGatedBundle(
  params: DeployGatedBundleParams,
  fetchImpl: typeof fetch = fetch,
  opts?: { onProgress?: (e: DeployProgressEvent) => void },
): Promise<LiveDeployResult> {
  // (1) GATE FIRST, FAIL CLOSED. A violation throws BundleGateError here, before any work
  // dir is written and before deployResource is ever reached.
  gateGeneratedBundle(params.bundle);

  // (2) Write the gated bundle to a fresh work dir.
  const workDir = await mkdtemp(join(tmpdir(), "utter-generated-bundle-"));
  await writeBundleToDir(params.bundle, workDir);

  // (3) Host-gate docker exactly like liveDeployEcho.
  const docker: DockerHandle | undefined = resolveDockerHandle();
  if (!docker) {
    throw new Error(
      "[live-deploy] must run on the provisioned gVisor host with UTTER_SANDBOX_HOST=1 " +
        "(it builds + runs the sidecar+handler pair under runsc). See infrastructure/RUNBOOK.md.",
    );
  }

  // (4) Run the deploy core with the work dir as the handlerBundleDir. Call through the
  // module namespace so the adversarial test can spy + assert ZERO calls. Forward opts so
  // progress events flow through. Thread the declared success input from the gated bundle's
  // test-cases.json so the paid smoke test replays the input G4 validated (not the generic
  // echo body) - fixes the 400 on handlers that validate their input.
  return self.deployResource(
    docker,
    {
      resourceId: params.resourceId,
      slug: params.slug,
      pricing: params.pricing,
      maxTimeoutSeconds: params.maxTimeoutSeconds,
      classifierSchema: params.classifierSchema,
      freePaths: params.freePaths,
      handlerBundleDir: workDir,
      successInput: selectDeclaredSuccessInput(params.bundle["test-cases.json"]),
    },
    fetchImpl,
    opts,
  );
}

// `resolveDockerHandle` + the `DockerHandle` type now live in orchestrate.ts (the
// canonical launch plane); they are imported above and re-exported here for
// back-compat with the barrel and existing callers. The old always-undefined stub
// is gone: resolveDockerHandle now constructs a real dockerode on the provisioned
// host (UTTER_SANDBOX_HOST=1) so the deploy can actually build + run the container.
export type { DockerHandle };

/** The blocked-host probe image the operator builds per the README. */
export const BLOCKED_HOST_PROBE_IMAGE = "utter/blocked-host-probe:latest";

/** Inputs to {@link buildProbeCreateOptions}. */
export interface BuildProbeCreateOptionsInput {
  /** The host the probe attempts to reach (rides in Cmd, NOT the image tag). */
  targetHost: string;
  /** The handler's pairnet network name the probe attaches to. */
  network: string;
  /** The probe image (defaults to {@link BLOCKED_HOST_PROBE_IMAGE}). */
  image?: string;
}

/**
 * Build the dockerode `createContainer` options for one blocked-host probe run.
 *
 * The image reference is the plain tag (no `#host` suffix - that is an INVALID
 * Docker reference that the old code produced and the daemon rejected with
 * "invalid reference format"). The dynamic target rides in `Cmd` instead.
 *
 * The probe attaches to the handler's PAIRNET (`NetworkMode: <network>`), the same
 * `internal: true` bridge the handler is on. That bridge has no gateway, so a probe
 * container joined to it has the SAME L3 reachability as the handler - it faithfully
 * tests the egress containment without sharing the handler's netns. This is
 * runtime-agnostic: it works whether the handler runs under runc or runsc, unlike a
 * `container:<handler>` netns share, which a runc probe cannot reliably observe
 * across a runsc userspace netstack.
 *
 * NOTE (out of scope here): the DEFAULT_PROBE_TARGETS "host-loopback" 127.0.0.1 is
 * the probe container's OWN loopback from inside any container, so that one target is
 * not a meaningful host-loopback test from a separate probe container. The other
 * targets (metadata 169.254.169.254, RFC1918, Arc RPC, facilitator) ARE correctly
 * tested from the pairnet. This is a pre-existing probe-semantics nuance.
 *
 * This is a pure function so the construction is unit-testable without a daemon -
 * the runtime probe run itself still needs the provisioned gVisor host.
 */
export function buildProbeCreateOptions(input: BuildProbeCreateOptionsInput): {
  Image: string;
  Cmd: string[];
  HostConfig: Record<string, unknown>;
} {
  return {
    // A VALID reference: the plain tag. The target is in Cmd, never the tag.
    Image: input.image ?? BLOCKED_HOST_PROBE_IMAGE,
    // The target host as the single command arg (the probe.sh entrypoint reads $1).
    Cmd: [input.targetHost],
    HostConfig: {
      // Attach to the handler's pairnet (same internal bridge, no gateway), so the
      // probe has the same reachability as the handler - runtime-agnostic, no
      // fragile netns sharing.
      NetworkMode: input.network,
      AutoRemove: true,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64,
      Memory: 64 * 1024 * 1024,
    },
  };
}

/**
 * The REAL PRX-02 egress assertion (design §4.3 residual risk 4 regression test).
 *
 * When a docker handle is available on the provisioned host, it drives the genuine
 * blocked-host probe-runner (createLiveHostProbe over a GvisorRunner) and asserts
 * every host in DEFAULT_PROBE_TARGETS (cloud metadata, RFC1918, Arc RPC,
 * facilitator, host loopback) is UNREACHABLE from inside the gVisor container
 * netns. `assertBlocked` throws ContainmentFailureError if ANY is reachable - the
 * containment failure that must fail the deploy.
 *
 * The probe is a TRUSTED operator tool, so it does NOT go through the locked
 * untrusted RunSpec (empty env, no cmd, which cannot carry a dynamic target).
 * Instead this injects a `connectProbe` that launches the blocked-host probe image
 * DIRECTLY via dockerode ({@link buildProbeCreateOptions}): a VALID image
 * reference, the target host in `Cmd`, attached to the HANDLER's pairnet (the same
 * internal no-gateway bridge) so the connect tests the handler's real reachability.
 * exit 0 == reachable == containment failure.
 *
 * When NO docker handle is available (the autonomous box), it SKIPS with a clear
 * operator-gated log and returns `false` - a skip, NOT a false pass and NOT a false
 * fail. The live PRX-02 acceptance is recorded as a Deferred Item until it runs on
 * the provisioned host (infrastructure/RUNBOOK.md Acceptance 1).
 *
 * @param docker the host dockerode handle (undefined on the autonomous box -> skip).
 * @param network the handler's pairnet network name the probe attaches to. Omitted
 *        only when docker is absent (the skip path never launches a probe).
 * @returns true only when the live probe actually ran and every target was
 *          unreachable; false when the probe was skipped (no host docker handle).
 */
export async function runEgressProbe(
  docker?: DockerHandle,
  network?: string,
): Promise<boolean> {
  if (!docker) {
    console.log(
      "[live-deploy] PRX-02 SKIPPED: no docker handle (operator-gated). The real " +
        "blocked-host probe runs only on the provisioned gVisor host (UTTER_SANDBOX_HOST=1); " +
        "recorded as a Deferred Item, NOT a pass.",
    );
    return false;
  }
  if (!network) {
    throw new Error(
      "runEgressProbe: a pairnet network name is required to run the live probe - the probe " +
        "attaches to the handler's pairnet (NetworkMode: <network>, the same internal no-gateway " +
        "bridge) to test the handler's real reachability. Thread pairnetName(SLUG) from the launch " +
        "into this call.",
    );
  }

  // The trusted boundary runner. createLiveHostProbe REFUSES a non-gvisor runner,
  // so a docker-dev box can never run this live. buildRunSpec yields the hardened
  // run-spec the probe interface still takes (the injected connectProbe launches
  // the probe image directly via dockerode and does not read the spec).
  const runner = new GvisorRunner(docker);
  const dockerApi = docker as unknown as Docker;
  const probe = createLiveHostProbe({
    runner,
    // Inject the host connectProbe: launch the probe image DIRECTLY via dockerode,
    // bypassing the locked RunSpec (which cannot carry a dynamic target). The image
    // reference is valid (target in Cmd), and it attaches to the handler's pairnet.
    connectProbe: async (_spec, target): Promise<boolean> => {
      const createOpts = buildProbeCreateOptions({
        targetHost: target.host,
        network,
      });
      const container = await dockerApi.createContainer(
        createOpts as unknown as Docker.ContainerCreateOptions,
      );
      await container.start();
      const result = (await container.wait()) as unknown as { StatusCode: number };
      // exit 0 -> the connect SUCCEEDED -> the host is REACHABLE (containment fail).
      return result.StatusCode === 0;
    },
  });
  const spec = buildRunSpec({
    image: BLOCKED_HOST_PROBE_IMAGE,
    backend: "gvisor",
    maxTimeoutSeconds: 30,
    limits: { pidsLimit: 128, memoryBytes: 256 * 1024 * 1024, cpus: 0.5 },
  });
  // Throws ContainmentFailureError if ANY target is reachable (deploy must fail).
  await probe.assertBlocked(spec, [...DEFAULT_PROBE_TARGETS]);
  console.log("[live-deploy] PRX-02 OK: every blocked host unreachable from the gVisor container netns");
  return true;
}

// Operator entry point: only runs when invoked directly (never on import in the
// autonomous suite). pathToFileURL normalizes process.argv[1] to the same WHATWG
// file:// href import.meta.url carries, so the direct-run check fires on Windows
// and POSIX alike (server.ts uses the same cross-platform pattern);
// import.meta.main is a Bun-ism that is always undefined on Node.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // DEPLOY_BUNDLE_PATH selects the GENERATED-bundle deploy; absent, the echo deploy runs.
  // Both return a LiveDeployResult and share the same logging + exit-1 chain.
  const bundlePath = process.env.DEPLOY_BUNDLE_PATH?.trim();
  const run = bundlePath ? deployGeneratedBundle(bundlePath) : liveDeployEcho();
  run
    .then((r) => {
      console.log(`[live-deploy] OK: ${r.url} 402(unpaid)->200(paid); PRX-02 unreachable=${r.nonAllowlistedUnreachable}`);
      if (r.settleTx) {
        console.log(`[live-deploy] settle tx ${r.settleTx} (debit ${r.debitAmount}, creator ${r.toCreator} / treasury ${r.toTreasury})`);
        console.log(`[live-deploy] ArcScan: ${arcTestnet.blockExplorers?.default.url}/tx/${r.settleTx}`);
      }
    })
    .catch((err: unknown) => {
      console.error("[live-deploy] failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
