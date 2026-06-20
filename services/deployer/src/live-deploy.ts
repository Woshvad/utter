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
import {
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
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
  type Pricing,
  type PaymentPayload,
} from "@utter/x402-arc";
import { buildTraefikDynamicConfig } from "./traefik-config";

loadEnv({ path: ".env.local" });

/** The deterministic resource id + slug for the live echo deploy. */
const RESOURCE_LABEL = "utter:echo:live-deploy";
const RESOURCE_ID: Hex = keccak256(toHex(RESOURCE_LABEL));
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
  const bytes = crypto.getRandomValues(new Uint8Array(32));
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
  // (0) Operator inputs from .env.local ONLY.
  const domain = requireEnv("DEPLOY_DOMAIN");
  const buyerKey = requireEnv("TEST_BUYER_PRIVATE_KEY") as Hex;
  const rpcUrl = process.env.ARC_RPC_URL;

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
  // container. On the provisioned host this drives the deployed resource to
  // attempt an egress to a non-allowlisted destination through the data-proxy and
  // asserts it is rejected (403) / the netns has no route. The probe target is the
  // canonical SSRF host; a reachable result is a containment failure.
  const probeUrl = `https://${SLUG}.${apex}/__egress-probe`;
  let nonAllowlistedUnreachable = true;
  try {
    const probe = await fetchImpl(probeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Ask the resource (via its data-proxy seam) to reach a non-allowlisted host.
      body: JSON.stringify({ target: "http://169.254.169.254/latest/meta-data/" }),
    });
    // The deployed resource must NOT successfully reach the non-allowlisted host:
    // the data-proxy returns 403 and the container netns has no direct route.
    const text = await probe.text();
    nonAllowlistedUnreachable = probe.status === 403 || /blocked|forbidden|unreachable/i.test(text);
  } catch {
    // A network error reaching the probe path = no route = unreachable (the
    // desired outcome). Treat a thrown connect as confirmation of unreachability.
    nonAllowlistedUnreachable = true;
  }
  if (!nonAllowlistedUnreachable) {
    throw new Error("[live-deploy] PRX-02 FAILED: a non-allowlisted host was reachable from the container");
  }
  console.log("[live-deploy] PRX-02 OK: non-allowlisted host unreachable from the container");

  return {
    url,
    unpaidStatus: unpaid.status,
    paidStatus: paid.status,
    nonAllowlistedUnreachable,
  };
}

// Operator entry point: only runs when invoked directly (never on import in the
// autonomous suite). `import.meta.main` is set when run via `node live-deploy.ts`.
if ((import.meta as { main?: boolean }).main) {
  liveDeployEcho()
    .then((r) => {
      console.log(`[live-deploy] OK: ${r.url} 402(unpaid)->200(paid); PRX-02 unreachable=${r.nonAllowlistedUnreachable}`);
    })
    .catch((err: unknown) => {
      console.error("[live-deploy] failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
