// compose.ts - the STU-01 composer input validation (the V5 security control).
//
// validateComposeSpec is the trust boundary between the untrusted browser form and
// adapter.createResource (T-06-INPUTVAL). The /create action runs this FIRST and
// rejects malformed input with field-level errors BEFORE the adapter is called, so
// no partial resource is ever created from bad input (reject-before-create).
//
// Money discipline (T-06-DECIMALS): a decimal USDC string is parsed to base-unit
// bigint using a `decimals` value supplied by the caller from a RUNTIME read (never
// a 1e6/6/18 literal here). parseUsdcToBaseUnits builds the scale as 10n ** BigInt(
// decimals) from that value - there is no scale literal in this file.
import type { ComposeSpec, Hex, PricingModel } from "../adapter/types.js";

/** Prompt length bounds (chars). Reject empty and oversized prompts (DoS / abuse). */
export const PROMPT_MIN = 8;
export const PROMPT_MAX = 2000;

/** The field-keyed error map a rejected validation returns. */
export type ComposeFieldErrors = Partial<
  Record<"prompt" | "pricingModel" | "basePrice" | "bond" | "payout", string>
>;

/** The raw form input (all strings, as a browser form delivers them). */
export interface ComposeInput {
  prompt: unknown;
  pricingModel: unknown;
  basePrice: unknown;
  bond: unknown;
  payout: unknown;
}

/** A discriminated validation result: ok carries the typed spec, else field errors. */
export type ComposeValidation =
  | { ok: true; spec: ComposeSpec }
  | { ok: false; errors: ComposeFieldErrors };

/** A well-formed 0x-prefixed 20-byte hex address (case-insensitive hex chars). */
function isHexAddress(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Parse a decimal USDC string (e.g. "0.010000") to base-unit bigint using a runtime
 * `decimals`. Returns null on any malformed numeric string. No scale LITERAL: the
 * 10^decimals factor is built from the passed decimals (T-06-DECIMALS).
 */
export function parseUsdcToBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  // digits, optional single decimal point, no sign, no exponent.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null; // more precision than the token supports
  const scale = 10n ** BigInt(decimals);
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt(whole) * scale + BigInt(fracPadded || "0");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validate a compose form payload. Runs every check and accumulates field errors so
 * the form can show them all at once. On success returns the typed ComposeSpec with
 * base-unit bigint money. `decimals` comes from a runtime read (caller), never a
 * literal - it is the single source of money scale for the parse.
 */
export function validateComposeSpec(input: ComposeInput, decimals: number): ComposeValidation {
  const errors: ComposeFieldErrors = {};

  // prompt: present + within length bounds
  const prompt = asString(input.prompt).trim();
  if (prompt.length === 0) {
    errors.prompt = "describe the endpoint in a sentence.";
  } else if (prompt.length < PROMPT_MIN) {
    errors.prompt = `prompt is too short (min ${PROMPT_MIN} chars).`;
  } else if (prompt.length > PROMPT_MAX) {
    errors.prompt = `prompt is too long (max ${PROMPT_MAX} chars).`;
  }

  // pricing model: flat | metered only
  const pricingModelRaw = asString(input.pricingModel);
  let pricingModel: PricingModel | null = null;
  if (pricingModelRaw === "flat" || pricingModelRaw === "metered") {
    pricingModel = pricingModelRaw;
  } else {
    errors.pricingModel = "pricing must be flat or metered.";
  }

  // base price: a valid decimal USDC string, > 0
  const basePriceStr = asString(input.basePrice);
  let basePrice: bigint | null = null;
  const parsedPrice = parseUsdcToBaseUnits(basePriceStr, decimals);
  if (parsedPrice === null) {
    errors.basePrice = "enter a valid usdc amount.";
  } else if (parsedPrice <= 0n) {
    errors.basePrice = "price must be greater than 0.";
  } else {
    basePrice = parsedPrice;
  }

  // bond: a valid decimal USDC string, > 0 (positive bond is the skin-in-the-game)
  const bondStr = asString(input.bond);
  let bond: bigint | null = null;
  const parsedBond = parseUsdcToBaseUnits(bondStr, decimals);
  if (parsedBond === null) {
    errors.bond = "enter a valid usdc bond amount.";
  } else if (parsedBond <= 0n) {
    errors.bond = "bond must be greater than 0.";
  } else {
    bond = parsedBond;
  }

  // payout: a well-formed hex address
  const payoutStr = asString(input.payout).trim();
  let payout: Hex | null = null;
  if (!isHexAddress(payoutStr)) {
    errors.payout = "enter a valid 0x payout address.";
  } else {
    payout = payoutStr;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // all non-null by construction once errors is empty
  return {
    ok: true,
    spec: {
      prompt,
      pricingModel: pricingModel as PricingModel,
      basePrice: basePrice as bigint,
      bond: bond as bigint,
      payout: payout as Hex,
    },
  };
}
