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
//
// validateAgentCard is a STRUCTURAL A2A-shape check only; it does NOT bind the
// money-critical fields. So after the structural gate we additionally PIN the money
// fields against the TRUSTED @utter/chain constants (CR-01 / T-07-CARDPOISON): the
// card.x402.escrow MUST equal the canonical PAYMENT_ESCROW and card.x402.asset MUST
// equal the canonical USDC, or we refuse to pay. The client only ever signs a
// DebitAuthorization whose verifyingContract is the real escrow. payTo must be a
// well-formed bytes32 sourced solely from the pinned card. The card's cap string is
// validated as a base-unit integer (fail-closed) BEFORE BigInt() so a hostile
// non-numeric pricing.max yields a clean rejection, never a raw SyntaxError (WR-05).
// The buyer-configured per-call ceiling (independent of the card) is enforced in
// client.pay(): the signed maxAmount is min(card cap, buyer ceiling) and never above it.
import { validateAgentCard } from "@utter/ai-runtime";
import { PAYMENT_ESCROW, USDC } from "@utter/chain";
import type { Pricing } from "@utter/x402-arc";

/** Case-insensitive 0x-address equality (addresses are not case-significant). */
function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

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
  //
  // WR-05: the card string is UNTRUSTED. Validate it is a plain base-unit integer
  // BEFORE BigInt() so a poisoned-but-structurally-valid card carrying a non-numeric
  // pricing.max ("1e9", "0x10", " 5 ", "abc") yields a clean, typed "invalid card"
  // rejection (fail-closed: never pays) instead of a raw SyntaxError leaking out.
  const capRaw = typeof pricingRaw.max === "string" ? pricingRaw.max : "0";
  if (!/^\d+$/.test(capRaw)) {
    throw new Error(
      `discover: card pricing.max ${JSON.stringify(capRaw)} is not a base-unit integer ` +
        `(refusing to pay)`,
    );
  }

  // CR-01: PIN the money fields against the TRUSTED on-chain constants. A structurally
  // valid card can still carry an attacker-chosen escrow/asset/payTo; we reject any card
  // whose escrow != the canonical PaymentEscrow or asset != the canonical USDC, and we
  // require payTo to be a well-formed bytes32 resourceId. After this gate the client only
  // ever signs a DebitAuthorization whose verifyingContract is the real escrow and whose
  // payTo came solely from the pinned card.
  const escrow = x402.escrow;
  const asset = x402.asset;
  const payTo = x402.payTo;
  if (typeof escrow !== "string" || !eqAddr(escrow, PAYMENT_ESCROW)) {
    throw new Error(
      "discover: card escrow does not match the trusted PaymentEscrow (refusing to pay)",
    );
  }
  if (typeof asset !== "string" || !eqAddr(asset, USDC)) {
    throw new Error("discover: card asset does not match the trusted USDC (refusing to pay)");
  }
  if (typeof payTo !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(payTo)) {
    throw new Error("discover: card payTo is not a bytes32 resourceId (refusing to pay)");
  }

  return {
    escrow: escrow as `0x${string}`,
    asset: asset as `0x${string}`,
    payTo: payTo as `0x${string}`,
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

  // (3) Pay inputs come ONLY from the validated card, and readCardInputs additionally
  // PINS escrow/asset against the trusted @utter/chain constants + validates payTo and
  // the cap string (CR-01 / WR-05) - a poisoned-but-structurally-valid card throws here.
  return { card, cardInputs: readCardInputs(card) };
}
