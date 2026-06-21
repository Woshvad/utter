// discover.ts - card fetch + validateAgentCard HARD-gate + readCardInputs projection
// (BUY-01, T-07-CARDPOISON).
//
// An external agent discovers a resource by reading ONLY its agent card. The card is
// UNTRUSTED JSON crossing a trust boundary: we HARD-gate on validateAgentCard BEFORE
// reading a single pay input. An invalid/poisoned card throws here and NEVER pays - no
// escrow address, payTo, or cap is read off a card that failed validation. The pay
// inputs (escrow/asset/payTo/pricing/cap) come SOLELY from card.x402; verified/bond from
// card.health/card.bond. This mirrors runTestEndpoint's readCardInputs (test-endpoint.ts
// lines 119-144) - the same projection, now gated.
import { validateAgentCard } from "@utter/ai-runtime";
import type { Pricing } from "@utter/x402-arc";

/** A minimal fetch shape (injectable; defaults to the global fetch). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Resolve a marketplace resourceId to its served card (the in-process fixture default). */
export type CardSource = (resourceId: string) => Promise<Record<string, unknown> | null>;

/** The pay inputs read ONLY from a VALIDATED card (the BUY-01 / T-07-CARDPOISON surface). */
export interface CardPayInputs {
  /** The escrow contract address from card.x402.escrow. */
  escrow: `0x${string}`;
  /** The USDC asset address from card.x402.asset. */
  asset: `0x${string}`;
  /** The resourceId payTo from card.x402.payTo (bytes32). */
  payTo: `0x${string}`;
  /** The metered pricing block from card.x402.pricing. */
  pricing: Pricing;
  /** The cap (escrow max) in base units from card.x402.pricing.max. */
  cap: bigint;
  /** Whether a bond is posted, read from card.bond.posted. */
  bondPosted: boolean;
  /** The reputation/health verified flag from card.health.verified. */
  verified: boolean;
}

/** The discover result: the validated card + the pay-input projection. */
export interface DiscoverResult {
  /** The parsed, validateAgentCard-valid card. */
  card: Record<string, unknown>;
  /** The pay inputs projected from the validated card (the ONLY pay source). */
  cardInputs: CardPayInputs;
}

/** Dependencies discover reads through (all injectable; fixture-safe defaults). */
export interface DiscoverDeps {
  /** Fetch a card by URL (defaults to the global fetch). */
  fetcher?: FetchLike;
  /** Resolve a marketplace resourceId to its card (required for the resourceId form). */
  cardSource?: CardSource;
}

/** The A2A card path suffix (EXACTLY this - never agent.json; Pitfall 5). */
const CARD_PATH = "/.well-known/agent-card.json";

/** Project the pay inputs off a VALIDATED card (copies readCardInputs, test-endpoint.ts). */
function readCardInputs(card: Record<string, unknown>): CardPayInputs {
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const pricingRaw = (x402.pricing as Record<string, unknown> | undefined) ?? {};
  const health = (card.health as Record<string, unknown> | undefined) ?? {};
  const bond = (card.bond as Record<string, unknown> | undefined) ?? {};
  const pricing: Pricing = {
    model: "metered",
    base: typeof pricingRaw.base === "string" ? pricingRaw.base : "0",
    perKB: typeof pricingRaw.perKB === "string" ? pricingRaw.perKB : "0",
    // The card's ProjectedPricing carries no computeMultiplier; a 0 compute term keeps
    // the metered amount bounded by the signed cap regardless (deterministic + safe).
    computeMultiplier:
      typeof pricingRaw.computeMultiplier === "string" ? pricingRaw.computeMultiplier : "0",
    maxResponseBytes:
      typeof pricingRaw.maxResponseBytes === "number" ? pricingRaw.maxResponseBytes : 1_048_576,
  };
  // The cap is the card's escrow max in base units (no decimals literal: the value is
  // already denominated in base units on the card; the runtime decimals read - the
  // precision witness - happens in the pay loop, not here).
  const capRaw = typeof pricingRaw.max === "string" ? pricingRaw.max : "0";
  return {
    escrow: x402.escrow as `0x${string}`,
    asset: x402.asset as `0x${string}`,
    payTo: x402.payTo as `0x${string}`,
    pricing,
    cap: BigInt(capRaw),
    bondPosted: bond.posted === true,
    verified: health.verified === true,
  };
}

/**
 * Discover a resource by its served agent card. Accepts EITHER a card URL (fetched
 * directly) OR a marketplace resourceId (resolved via the injected cardSource - the
 * live marketplace read is operator-gated; the fixture returns a known card). Steps:
 *   (1) FETCH the card (non-200 -> "not discoverable"; no card -> "not discoverable").
 *   (2) HARD-GATE on validateAgentCard. !valid -> throw with the validation errors and
 *       read NO pay input (T-07-CARDPOISON: an invalid card never pays).
 *   (3) PROJECT the pay inputs off the validated card ONLY.
 */
export async function discover(
  ref: { cardUrl: string } | { resourceId: string },
  deps: DiscoverDeps = {},
): Promise<DiscoverResult> {
  let card: Record<string, unknown> | null = null;

  if ("cardUrl" in ref) {
    const fetcher = deps.fetcher ?? (globalThis.fetch as unknown as FetchLike);
    const url = ref.cardUrl.endsWith(CARD_PATH) ? ref.cardUrl : ref.cardUrl + CARD_PATH;
    const res = await fetcher(url, { method: "GET" });
    if (res.status !== 200) {
      throw new Error(`discover: ${ref.cardUrl} is not discoverable (status ${res.status})`);
    }
    card = (await res.json()) as Record<string, unknown>;
  } else {
    if (!deps.cardSource) {
      throw new Error(
        "discover: resolving a resourceId requires an injected cardSource (the live " +
          "marketplace read is operator-gated; the fixture supplies a known card).",
      );
    }
    card = await deps.cardSource(ref.resourceId);
    if (!card) {
      throw new Error(`discover: resource ${ref.resourceId} is not discoverable (no agent card)`);
    }
  }

  // (2) HARD GATE - validate BEFORE trusting. A poisoned/invalid card throws here and
  // NO pay input is read (the readCardInputs call below is unreachable on !valid).
  const check = validateAgentCard(card);
  if (!check.valid) {
    throw new Error(`discover: invalid agent card (never pays): ${JSON.stringify(check.errors)}`);
  }

  // (3) Pay inputs come ONLY from the validated card.
  return { card, cardInputs: readCardInputs(card) };
}
