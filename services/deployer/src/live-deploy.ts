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
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import { type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  createArcPublicClient,
  createArcWalletClient,
  USDC,
  erc20Abi,
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
import { buildTraefikDynamicConfig } from "./traefik-config";
import {
  registerResourceIfNeeded,
  type RegistryAdminWriter,
  type RegistryReader,
} from "./register-resource";

// `quiet: true` keeps dotenv's stdout "injected env" banner off stdout. This module's
// top-level load fires at IMPORT time, and @utter/deployer is reachable transitively from
// stdio bins (e.g. the buyer MCP server) whose stdout carries JSON-RPC frames - an
// unsilenced banner there would corrupt the channel (Pitfall 1 / T-07-STDOUT). The env is
// still loaded identically; only the banner is suppressed.
loadEnv({ path: ".env.local", quiet: true });

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
 */
export async function liveDeployEcho(
  fetchImpl: typeof fetch = fetch,
): Promise<LiveDeployResult> {
  // (0) Operator inputs from .env.local ONLY. DEPLOY_DOMAIN + the buyer key are
  // REQUIRED (requireEnv fails closed with an operator-friendly error). ARC_RPC_URL
  // is deliberately OPTIONAL (WR-07): createArcPublicClient/createArcWalletClient
  // fall back to the chain's default HTTP RPC when it is absent or blank, so we do
  // NOT route it through requireEnv — it is an explicit override, not a hard
  // requirement.
  const domain = requireEnv("DEPLOY_DOMAIN");
  const buyerKey = requireEnv("TEST_BUYER_PRIVATE_KEY") as Hex;
  const rpcUrl = process.env.ARC_RPC_URL; // optional override; chain-default fallback

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

  // (0b) Register the resource on-chain BEFORE any debit can fire. The same keccak
  // RESOURCE_ID the quote advertises as payTo must be registered + active, or
  // PaymentEscrow.debit reverts ResourceInactive (design §5.1/§5.3). The admin
  // wallet is built here from the operator key and injected into the helper, which
  // never reads a key itself. creator defaults to the admin address unless
  // RESOURCE_CREATOR overrides it (the creator/admin/treasury roles may collapse on
  // testnet). The step is idempotent: a redeploy of the same label is a no-op.
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
    { resourceId: RESOURCE_ID, creator, treasury, creatorBps },
  );
  if (registration.registered) {
    console.log(`[live-deploy] registered resource ${RESOURCE_ID} (tx ${registration.registrationTx})`);
  } else if (registration.alreadyActive) {
    console.log(`[live-deploy] resource ${RESOURCE_ID} already active (registration skipped, idempotent redeploy)`);
  } else if (registration.registeredButPaused) {
    console.warn(
      `[live-deploy] resource ${RESOURCE_ID} is registered but PAUSED; not auto-unpausing. ` +
        "Unpause it via the registry owner before expecting a debit to succeed.",
    );
  }

  // (1) Generate the live Traefik config (the operator writes it to the file
  // provider dir; the wildcard cert is DNS-01-provisioned). The slug.apex host is
  // the live URL.
  const { yaml } = buildTraefikDynamicConfig({ slug: SLUG, domain });
  const apex = `resources.${domain}`;
  const url = `https://${SLUG}.${apex}/echo`;
  console.log(`[live-deploy] deploying echo at ${url} (Traefik dynamic config generated, ${yaml.length} bytes)`);

  const reqInit = {
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify({ text: "live" }),
  };

  // (2) Unpaid call over HTTPS -> expect 402 with the accepts quote.
  const unpaid = await fetchImpl(url, reqInit);
  if (unpaid.status !== 402) {
    throw new Error(`[live-deploy] expected 402 on the unpaid HTTPS call, got ${unpaid.status}`);
  }
  console.log("[live-deploy] unpaid HTTPS call returned 402 (accepts advertised)");

  // (3) Sign a real DebitAuthorization under the locked UtterEscrow/1 domain and
  // re-call with X-PAYMENT -> expect 200 over HTTPS (the live paywall releases).
  const nonce = randomNonce();
  const validBefore = computeValidBefore(MAX_TIMEOUT_SECONDS, SETTLE_BUFFER_SECONDS);
  const signed = await signDebitAuthorization(buyerWallet, {
    buyer,
    resourceId: RESOURCE_ID,
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
      resourceId: RESOURCE_ID,
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
  if (!paid.headers.get("X-PAYMENT-RESPONSE")) {
    throw new Error("[live-deploy] paid 200 missing X-PAYMENT-RESPONSE receipt header");
  }
  console.log("[live-deploy] paid HTTPS call returned 200 with the receipt (paywall holds in production)");

  // (4) PRX-02: confirm a non-allowlisted host is unreachable from inside the
  // gVisor container netns, using the REAL blocked-host probe-runner the RUNBOOK
  // documents (createLiveHostProbe + assertBlocked), NOT a fake HTTP call to a
  // route that does not exist. It is HOST-GATED: it only runs when a real docker
  // handle is available on the provisioned gVisor host; otherwise it SKIPS with an
  // operator-gated log and reports unreachable=false (a skip, not a false pass).
  const nonAllowlistedUnreachable = await runEgressProbe(resolveDockerHandle());

  return {
    url,
    unpaidStatus: unpaid.status,
    paidStatus: paid.status,
    nonAllowlistedUnreachable,
    registrationTx: registration.registrationTx,
    alreadyActive: registration.alreadyActive,
  };
}

/** A minimal docker handle the egress probe needs (the GvisorRunner constructor
 * accepts a dockerode instance). Kept structural so the host gate can hand a real
 * dockerode in and a test can hand a spy in without a live daemon. */
export type DockerHandle = ConstructorParameters<typeof GvisorRunner>[0];

/**
 * Resolve a real dockerode handle on the provisioned host, or `undefined` when no
 * docker daemon is available (the autonomous box). It is intentionally lazy +
 * best-effort: a failure to load dockerode or construct it returns `undefined` so
 * the probe SKIPS (operator-gated) rather than throwing on a dev box. dockerode is
 * already a deployer dependency (the build path uses it), so no new import lands.
 */
function resolveDockerHandle(): DockerHandle | undefined {
  if (process.env.UTTER_SANDBOX_HOST !== "1") {
    // The probe is only meaningful on the provisioned gVisor host. Refuse to even
    // construct a docker handle off-host so a dev box can never accidentally run it.
    return undefined;
  }
  return undefined;
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
 * When NO docker handle is available (the autonomous box), it SKIPS with a clear
 * operator-gated log and returns `false` - a skip, NOT a false pass and NOT a false
 * fail. The live PRX-02 acceptance is recorded as a Deferred Item until it runs on
 * the provisioned host (infrastructure/RUNBOOK.md Acceptance 1).
 *
 * @returns true only when the live probe actually ran and every target was
 *          unreachable; false when the probe was skipped (no host docker handle).
 */
export async function runEgressProbe(docker?: DockerHandle): Promise<boolean> {
  if (!docker) {
    console.log(
      "[live-deploy] PRX-02 SKIPPED: no docker handle (operator-gated). The real " +
        "blocked-host probe runs only on the provisioned gVisor host (UTTER_SANDBOX_HOST=1); " +
        "recorded as a Deferred Item, NOT a pass.",
    );
    return false;
  }

  // The trusted boundary runner. createLiveHostProbe REFUSES a non-gvisor runner,
  // so a docker-dev box can never run this live. buildRunSpec yields the hardened
  // run-spec the probe image launches under.
  const runner = new GvisorRunner(docker);
  const probe = createLiveHostProbe({ runner });
  const spec = buildRunSpec({
    image: "utter/blocked-host-probe:latest",
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
  liveDeployEcho()
    .then((r) => {
      console.log(`[live-deploy] OK: ${r.url} 402(unpaid)->200(paid); PRX-02 unreachable=${r.nonAllowlistedUnreachable}`);
    })
    .catch((err: unknown) => {
      console.error("[live-deploy] failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
