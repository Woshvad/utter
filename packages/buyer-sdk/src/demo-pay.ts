// demo-pay.ts - runDemoPay: fund the buyer escrow ONCE, then fire N real paid calls to a
// DEPLOYED Utter resource. This is the demo "an agent pays per call" driver AND a live
// smoke test the operator runs before recording.
//
// WHY IT EXISTS: liveTestEndpoint (@utter/marketplace) pays but does NOT deposit. It
// assumes the buyer already holds >= cap credited in PaymentEscrow. A fresh test-buyer with
// a 0 escrow balance therefore runs 402 -> sign -> settle-FAILS -> non-200 ("not paid").
// runDemoPay closes that gap: it sizes the deposit to exactly cap * calls and funds it once
// (via the proven ensureDeposit), then runs the proven liveTestEndpoint N times.
//
// WHAT IT DOES NOT DO: it changes NEITHER primitive. The escrow gate, facilitator, splitter,
// and contracts are BYTE-UNCHANGED. This module only ORCHESTRATES a deposit before, and N
// pays over, the existing flow. reserve-before-run and exactly-once stay inside the frozen
// gate; no signing/settlement logic is re-implemented here.
//
// SAFETY:
//   - DEFAULT is a DRY-RUN: it reads the card + the buyer's escrow balance and prints the
//     sizing plan, making ZERO chain writes and ZERO paid calls. `apply: true` is required
//     to deposit + pay.
//   - This module is KEYLESS: the caller injects an already-built walletClient + publicClient
//     (the bin builds them from TEST_BUYER_PRIVATE_KEY). Nothing here reads or can log the key.
//   - No decimals literal in any amount path: ensureDeposit reads decimals() at runtime; the
//     amounts here are base-unit bigints carried straight from the card cap.
import type { PublicClient } from "viem";
import { escrowAbi, PAYMENT_ESCROW } from "@utter/chain";
import { liveTestEndpoint, type TestEndpointResult } from "@utter/marketplace";
import {
  ensureDeposit,
  type EnsureDepositResult,
  type DepositWalletClient,
} from "./deposit.js";

/** A 0x-prefixed bytes32 (a resourceId). */
type Hex = `0x${string}`;

/** The A2A card path suffix the deployed resource serves (EXACTLY this; never agent.json). */
const CARD_PATH = "/.well-known/agent-card.json";

/**
 * A minimal HTTP fetch shape (injectable for the offline test; defaults to the global fetch).
 * It matches the shape liveTestEndpoint accepts, so the SAME transport flows into the card
 * sizing read here and the pay loop there.
 */
export type HttpFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

/** Parsed CLI arguments (a pure function so the bin arg surface is unit-tested). */
export interface DemoPayArgs {
  /** The resource base URL or its full agent-card URL (the discovery source). */
  cardUrl: string;
  /** How many real paid calls to fire (>= 1). Sizes the one-time deposit to cap * calls. */
  calls: number;
  /** When false (the default) it is a DRY-RUN: reads + plan only, no writes, no pays. */
  apply: boolean;
  /** Optional on-chain resourceId to BIND the card payTo against (H4); omitted -> trust by URL. */
  resourceId?: Hex;
  /** Optional request body POSTed to the handler (defaults to a benign echo body). */
  requestBody?: unknown;
}

/**
 * Parse the demo-pay CLI argv (everything after the script name). Pure + total: it never
 * reads env or the network, so the bin's argument surface is unit-testable. Unknown --flags
 * and a missing --url are hard errors (fail-closed), and --calls must be a positive integer.
 */
export function parseDemoPayArgs(argv: readonly string[]): DemoPayArgs {
  let cardUrl: string | undefined;
  let calls = 1;
  let apply = false;
  let resourceId: string | undefined;
  let requestBody: unknown;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--url":
      case "--card-url":
        cardUrl = argv[++i];
        break;
      case "--calls":
        calls = Number(argv[++i]);
        break;
      case "--resource-id":
        resourceId = argv[++i];
        break;
      case "--body": {
        const raw = argv[++i];
        requestBody = raw ? (JSON.parse(raw) as unknown) : undefined;
        break;
      }
      case "--apply":
        apply = true;
        break;
      default:
        if (a && a.startsWith("--")) {
          throw new Error(`demo-pay: unknown flag ${a}`);
        }
    }
  }

  if (!cardUrl) {
    throw new Error("demo-pay: --url <resource base or agent-card URL> is required");
  }
  if (!Number.isInteger(calls) || calls < 1) {
    throw new Error(`demo-pay: --calls must be a positive integer (got ${String(calls)})`);
  }
  if (resourceId !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(resourceId)) {
    throw new Error("demo-pay: --resource-id must be a 0x-prefixed bytes32");
  }
  return { cardUrl, calls, apply, resourceId: resourceId as Hex | undefined, requestBody };
}

/** Options for {@link runDemoPay}. The wallet + client are injected (this module is keyless). */
export interface DemoPayOptions {
  /** The resource base URL or its full agent-card URL (the discovery source). */
  cardUrl: string;
  /** How many real paid calls to fire (>= 1). The one-time deposit is sized to cap * calls. */
  calls: number;
  /** false (default) = DRY-RUN (reads + plan only); true = deposit + pay. */
  apply: boolean;
  /** The buyer's wallet client (signs approve + deposit + the DebitAuthorization). */
  walletClient: DepositWalletClient;
  /** The chain read client (escrow balanceOf + the runtime decimals read inside ensureDeposit). */
  publicClient: PublicClient;
  /** Optional resourceId to BIND the card payTo against (H4); omitted -> trust the card by URL. */
  resourceId?: Hex;
  /** Optional request body POSTed to the handler (defaults to a benign echo body). */
  requestBody?: unknown;
  /** The env forwarded to liveTestEndpoint (only used by it when NOT injected; harmless here). */
  env?: NodeJS.ProcessEnv;
  /** Injectable HTTP transport (the offline test seam). Omitted -> the global fetch. */
  fetcher?: HttpFetch;
  /** Injectable deposit seam (the offline test seam). Omitted -> the real ensureDeposit. */
  deposit?: typeof ensureDeposit;
  /** Injectable pay seam (the offline test seam). Omitted -> the real liveTestEndpoint. */
  runLive?: typeof liveTestEndpoint;
  /** Progress sink (defaults to console.log). The bin passes console.log; the test captures. */
  log?: (message: string) => void;
}

/** The outcome of a runDemoPay run (for the bin summary + the test assertions). */
export interface DemoPayResult {
  /** True iff writes were performed (deposit + pays); false for a dry-run. */
  applied: boolean;
  /** The buyer EOA address (from the injected wallet). */
  buyer: string;
  /** The full agent-card URL discovered (base + the A2A card path). */
  cardUrl: string;
  /** The derived pay URL (base + /call). */
  endpointUrl: string;
  /** The per-call cap in base units, read from the card pricing.max. */
  cap: bigint;
  /** The number of paid calls requested. */
  calls: number;
  /** The escrow balance the buyer must hold to cover every call (cap * calls). */
  neededCap: bigint;
  /** The buyer's escrow credited balance read at entry (base units). */
  escrowBalanceBefore: bigint;
  /** The deposit outcome, or null on a dry-run. */
  deposited: EnsureDepositResult | null;
  /** The per-call pay results, or [] on a dry-run. */
  runs: TestEndpointResult[];
  /** The total on-chain debit across all paid calls (base units). */
  totalDebited: bigint;
  /** How many calls returned 200 + a receipt. */
  paidCount: number;
}

/** Derive the full agent-card URL (append the A2A card path only if absent). */
function toCardUrl(cardUrl: string): string {
  return cardUrl.endsWith(CARD_PATH) ? cardUrl : cardUrl + CARD_PATH;
}

/** Derive the pay URL (strip a trailing card path to the base, then append /call). */
function toEndpointUrl(cardUrl: string): string {
  const base = cardUrl.endsWith(CARD_PATH) ? cardUrl.slice(0, -CARD_PATH.length) : cardUrl;
  return `${base.replace(/\/+$/, "")}/call`;
}

/**
 * Read the per-call cap (base units) from the served card's x402.pricing.max. The card is
 * UNTRUSTED JSON; validate pricing.max is a plain base-unit integer BEFORE BigInt() so a
 * poisoned/non-numeric cap fails closed (never deposits, never pays), never a raw
 * SyntaxError. This is a SIZING read only; liveTestEndpoint re-validates + PINS the whole
 * card strictly (readCardInputsStrict) at pay time, so this light read cannot weaken the gate.
 */
function readCapFromCard(card: Record<string, unknown>): bigint {
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const pricing = (x402.pricing as Record<string, unknown> | undefined) ?? {};
  const capRaw = typeof pricing.max === "string" ? pricing.max : "";
  if (!/^\d+$/.test(capRaw)) {
    throw new Error(
      `demo-pay: card pricing.max ${JSON.stringify(capRaw)} is not a base-unit integer ` +
        `(refusing to deposit or pay)`,
    );
  }
  const cap = BigInt(capRaw);
  if (cap <= 0n) {
    throw new Error(`demo-pay: card pricing.max ${capRaw} is not a positive cap`);
  }
  return cap;
}

/**
 * Fund the buyer escrow once (sized to cap * calls), then fire N real paid calls to the
 * deployed resource. See the file header for the safety model. Steps:
 *   (1) DISCOVER the card (the SOLE cap source) and derive the pay URL.
 *   (2) SIZE: cap = card pricing.max; neededCap = cap * calls; read the buyer escrow balance.
 *   (3) PLAN: always log the sizing plan (base units). On a dry-run, stop here (no writes).
 *   (4) FUND: ensureDeposit(neededCap) - deposit-once (zero writes if already funded).
 *   (5) PAY: liveTestEndpoint N times (each 402 -> sign cap -> X-PAYMENT -> 200 + receipt).
 */
export async function runDemoPay(opts: DemoPayOptions): Promise<DemoPayResult> {
  const {
    calls,
    apply,
    walletClient,
    publicClient,
    resourceId,
    requestBody,
    env,
  } = opts;
  const fetcher: HttpFetch = opts.fetcher ?? ((input, init) => fetch(input, init as RequestInit));
  const deposit = opts.deposit ?? ensureDeposit;
  const runLive = opts.runLive ?? liveTestEndpoint;
  const log = opts.log ?? ((m: string) => console.log(m));

  if (!Number.isInteger(calls) || calls < 1) {
    throw new Error(`demo-pay: calls must be a positive integer (got ${String(calls)})`);
  }

  const buyer = walletClient.account.address as Hex;
  const cardUrl = toCardUrl(opts.cardUrl);
  const endpointUrl = toEndpointUrl(opts.cardUrl);

  // (1) DISCOVER - fetch the card (the SOLE cap source for sizing). A non-200 means the
  // resource is not discoverable; we never deposit or pay against a missing card.
  const res = await fetcher(cardUrl, { method: "GET" });
  if (res.status !== 200) {
    throw new Error(`demo-pay: ${cardUrl} is not discoverable (status ${res.status})`);
  }
  const card = (await res.json()) as Record<string, unknown>;

  // (2) SIZE - cap from the card; the deposit target covers every call.
  const cap = readCapFromCard(card);
  const neededCap = cap * BigInt(calls);
  const escrowBalanceBefore = (await publicClient.readContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;
  const depositShortfall = neededCap > escrowBalanceBefore ? neededCap - escrowBalanceBefore : 0n;

  // (3) PLAN - always logged (base units; the human figure needs a decimals read, so we
  // keep the exact base-unit truth here and let the caller format if desired).
  log("[demo-pay] plan (all amounts in USDC base units):");
  log(`  buyer:           ${buyer}`);
  log(`  card:            ${cardUrl}`);
  log(`  endpoint:        ${endpointUrl}`);
  log(`  cap per call:    ${cap.toString()}`);
  log(`  calls:           ${calls}`);
  log(`  needed escrow:   ${neededCap.toString()}`);
  log(`  escrow now:      ${escrowBalanceBefore.toString()}`);
  log(`  deposit needed:  ${depositShortfall.toString()}`);
  log(`  mode:            ${apply ? "APPLY (deposit + pay)" : "DRY-RUN (no writes, no pays)"}`);

  if (!apply) {
    return {
      applied: false,
      buyer,
      cardUrl,
      endpointUrl,
      cap,
      calls,
      neededCap,
      escrowBalanceBefore,
      deposited: null,
      runs: [],
      totalDebited: 0n,
      paidCount: 0,
    };
  }

  // (4) FUND - deposit-once, sized to cover every call. ensureDeposit reads the escrow
  // balance again, reads decimals() at runtime, and (only if short) approves USDC then
  // deposits the shortfall. If already funded it makes zero writes.
  const deposited = await deposit({ publicClient, walletClient, buyer, neededCap });
  if (deposited.deposited) {
    log(
      `[demo-pay] deposited ${deposited.topUp.toString()} base units` +
        `${deposited.approved ? " (approve + deposit)" : " (deposit only)"}` +
        `${deposited.depositTx ? ` tx=${deposited.depositTx}` : ""}`,
    );
  } else {
    log("[demo-pay] escrow already funded (no deposit needed)");
  }

  // (5) PAY - fire N real paid calls through the deployed gate. Inject the SAME wallet +
  // client + fetcher so no new key read happens (liveTestEndpoint only reads the env key
  // when a wallet/client is NOT injected; here both are).
  const runs: TestEndpointResult[] = [];
  let totalDebited = 0n;
  let paidCount = 0;
  for (let i = 0; i < calls; i++) {
    const run = await runLive({
      cardUrl,
      endpointUrl,
      resourceId,
      requestBody,
      env,
      fetcher,
      publicClient,
      buyerWallet: walletClient,
    });
    runs.push(run);
    totalDebited += run.debitAmount;
    if (run.paid) paidCount += 1;
    log(
      `[demo-pay] call ${i + 1}/${calls}: status=${run.status} paid=${run.paid} ` +
        `debit=${run.debitAmount.toString()} idem=${run.idemKey}`,
    );
  }

  log(
    `[demo-pay] done: ${paidCount}/${calls} paid, total debited ${totalDebited.toString()} ` +
      `base units (the creator accrues the 70% majority per the on-chain splitter)`,
  );

  return {
    applied: true,
    buyer,
    cardUrl,
    endpointUrl,
    cap,
    calls,
    neededCap,
    escrowBalanceBefore,
    deposited,
    runs,
    totalDebited,
    paidCount,
  };
}
