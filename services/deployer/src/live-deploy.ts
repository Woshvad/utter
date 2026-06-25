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
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
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
  sidecarContainerUrl,
  writeTraefikDynamicFile,
  waitForUnpaid402,
  type DockerHandle,
} from "./orchestrate";
import { mintFacilitatorToken } from "./facilitator-token";

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

  // (0c) BUILD + RUN the sidecar+handler PAIR as hardened runsc services. This is
  // the genuine launch the curl needs: without the running containers the URL serves
  // nothing. It is HOST-GATED (UTTER_SANDBOX_HOST=1): resolveDockerHandle returns
  // undefined off-host, so refuse loudly rather than curling a dead URL.
  //
  // NOTE: the pair's live path now REQUIRES wave BD's six-network compose to be
  // applied on the host first - the default proxynet/ingress/controlplane networks
  // must exist or the launch (and the post-create extra-net attach) fail. Apply BD,
  // then run this; see infrastructure/RUNBOOK.md.
  const docker: DockerHandle | undefined = resolveDockerHandle();
  if (!docker) {
    throw new Error(
      "[live-deploy] must run on the provisioned gVisor host with UTTER_SANDBOX_HOST=1 " +
        "(it builds + runs the sidecar+handler pair under runsc). See infrastructure/RUNBOOK.md.",
    );
  }
  // Resolve the facilitator URL the SIDECAR (only) will POST verify/settle/release
  // to. An explicit FACILITATOR_URL env override still wins (a non-default deploy);
  // otherwise we auto-resolve the facilitator's on-network IP. The IP (not the name)
  // is mandatory because the sidecar runs under runsc, which cannot use Docker's
  // embedded DNS at 127.0.0.11 (the name `facilitator` would EAI_AGAIN inside the
  // container). The resolved value is a non-secret IP:port, safe to log. The handler
  // never sees this value.
  const facilitatorUrl =
    process.env.FACILITATOR_URL?.trim() || (await resolveFacilitatorUrl(docker));
  console.log(`[live-deploy] facilitator resolved to ${facilitatorUrl}`);

  // Mint the per-resource caller-auth token the SIDECAR presents to the facilitator
  // (C1). It is bound to RESOURCE_ID; the untrusted handler NEVER receives it. NEVER
  // logged. The classifier schema is the public echo openapi (declared-errors free).
  const facilitatorToken = mintFacilitatorToken({
    resourceId: RESOURCE_ID,
    secret: facilitatorAuthSecret,
  });
  const classifierSchema = readFileSync(ECHO_OPENAPI_PATH, "utf8");

  const { handlerName, sidecarName } = pairNames(SLUG);
  const launched = await launchResourcePair(docker, {
    resourceId: RESOURCE_ID,
    slug: SLUG,
    cap,
    pricing: PRICING,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    facilitatorUrl,
    facilitatorToken,
    classifierSchema,
    // The echo's ONLY free route is its A2A discovery card; everything else is gated.
    // Explicit here to document intent (this is also buildSidecarServiceEnv's default).
    // PRICING.maxResponseBytes already flows via `pricing` above, so fix F2's
    // MAX_RESPONSE_BYTES now reaches the sidecar's metering + bounded proxy read.
    freePaths: ["/.well-known/agent-card.json"],
  });
  console.log(
    `[live-deploy] pair running under runsc: handler ${handlerName} (image ` +
      `${launched.handlerImage}), sidecar ${sidecarName} (image ${launched.sidecarImage})`,
  );

  // (1) WRITE the live Traefik route to disk (atomically) so the file provider
  // hot-loads a router for Host(<slug>.resources.<domain>) -> the SIDECAR container.
  // The wildcard cert is DNS-01-provisioned. The slug.apex host is the URL. Traefik
  // points at the sidecar (not the handler): the 402->200 flows Traefik -> sidecar
  // -> handler, and the sidecar serves /echo and proxies it to the gate-less handler.
  const apex = `resources.${domain}`;
  const url = `https://${SLUG}.${apex}/echo`;
  const routePath = await writeTraefikDynamicFile({
    slug: SLUG,
    domain,
    containerUrl: sidecarContainerUrl(SLUG),
  });
  console.log(`[live-deploy] deploying echo at ${url} (Traefik route written to ${routePath})`);

  const reqInit = {
    method: "POST",
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify({ text: "live" }),
  };

  // (2) Unpaid call over HTTPS -> expect 402 with the accepts quote. Poll until the
  // paywall is live: a fresh deploy needs the container to boot + the first-time
  // ACME wildcard cert to issue, during which the URL transiently throws/404s/502s.
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
    nonAllowlistedUnreachable = await runEgressProbe(docker);
  } else {
    console.log(
      "[live-deploy] PRX-02 SKIPPED (Phase 1): set UTTER_RUN_EGRESS_PROBE=1 to run the " +
        "blocked-host probe. The full egress enforcement lands with the Phase 2 nftables " +
        "increment; recorded as a skip, NOT a pass.",
    );
  }

  return {
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
}

// `resolveDockerHandle` + the `DockerHandle` type now live in orchestrate.ts (the
// canonical launch plane); they are imported above and re-exported here for
// back-compat with the barrel and existing callers. The old always-undefined stub
// is gone: resolveDockerHandle now constructs a real dockerode on the provisioned
// host (UTTER_SANDBOX_HOST=1) so the deploy can actually build + run the container.
export type { DockerHandle };

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
