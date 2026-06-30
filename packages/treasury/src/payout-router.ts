// payout-router.ts - route a creator payout in USDC (default) or EURC (per-payee
// opt-in) (SCL-03).
//
// Mirrors services/facilitator/src/settle.ts: it branches on a PayoutAsset
// discriminant EXACTLY as settle() branches on isExact(payment), and - like the
// settle module header states - it NEVER encodes a decimals literal. Both the USDC
// and the EURC amount path read decimals() at runtime through an injected reader
// (CHAIN-03 / 08-RESEARCH Pitfall 6: EURC is documented as 6dp but is read at
// runtime, never hardcoded). All amounts are base-unit bigint; the 18dp native gas
// token never enters this 6dp ERC-20 path.
//
// Asset control (T-08-ASSETCTRL): the payout asset is per-payee CONFIG, not a
// caller field. route(config, amount) has no asset-override argument, so a caller
// cannot flip a USDC-configured payee to EURC.
import type { Address } from "viem";
import { USDC, EURC } from "@utter/chain";
import type { StableFxAdapter } from "./stablefx-adapter";

/** The payout asset discriminant: USDC is the default, EURC is per-payee opt-in. */
export type PayoutAsset = "USDC" | "EURC";

/**
 * The runtime decimals() reader. Reading decimals() per asset at the money boundary
 * is the structural guard against hardcoding the token's decimals (CHAIN-03). The
 * default reads the on-chain decimals() via @utter/chain; tests inject a stub that
 * still returns its value FROM a decimals() call, never a literal.
 */
export interface DecimalsReader {
  /** Read the runtime decimals() of `token`. */
  decimals(token: Address): Promise<number>;
}

/** Basis-point denominator for a slippage tolerance (100% = 10000 bps). */
const BPS_DENOMINATOR = 10_000n;

/**
 * Slippage / min-out bounds for the EURC swap leg. A hostile or buggy RFQ adapter
 * controls both the quote and the realized swap return, so the router NEVER trusts
 * the swap output unbounded: the caller declares either an absolute floor (`minOut`)
 * or a tolerance from the quote (`maxSlippageBps`), and the router rejects a swap
 * whose realized amount falls below that floor. Omit both for the strict default
 * (the realized swap must be at least the quoted outAmount, zero slippage).
 */
export interface SwapBounds {
  /**
   * The absolute minimum base-unit amount of the output asset the payee will accept.
   * The router rejects the payout when the realized swap is below this floor.
   */
  readonly minOut?: bigint;
  /**
   * The maximum slippage from the quote, in basis points, the payee tolerates. The
   * router rejects a realized swap below quote.outAmount * (10000 - bps) / 10000.
   */
  readonly maxSlippageBps?: number;
}

/**
 * Per-payee payout configuration. The `asset` lives HERE (per-payee config), not on
 * the call - this is the asset-control invariant. EURC is opt-in; absent config
 * defaults to USDC at the router.
 */
export interface PayeeConfig {
  /** The creator/payee receiving the payout. */
  readonly payee: Address;
  /** The payout asset for THIS payee (per-payee opt-in; not caller-controlled). */
  readonly asset: PayoutAsset;
}

/** The resolved payout: which token, how much (base units), and the runtime decimals. */
export interface PayoutResult {
  /** The asset actually paid. */
  readonly asset: PayoutAsset;
  /** The token address paid (USDC or EURC from @utter/chain). */
  readonly token: Address;
  /** The base-unit amount paid (post-swap for EURC). */
  readonly amount: bigint;
  /** The token decimals read at runtime (never a literal). */
  readonly decimals: number;
  /** True when the payout was routed through a StableFX swap (EURC path). */
  readonly swapped: boolean;
}

/** Everything the router needs injected: the swap adapter + the runtime decimals reader. */
export interface PayoutRouterDeps {
  /** The StableFX swap seam (MockStableFx default / LiveStableFx gated). */
  readonly fx: StableFxAdapter;
  /** The runtime decimals() reader (no decimals literal in this module). */
  readonly decimalsReader: DecimalsReader;
}

/**
 * Routes a creator payout to the per-payee configured asset. USDC is the default
 * (pays straight through); EURC is per-payee opt-in and routes the amount through
 * the StableFX adapter (quote + swap) before paying EURC. Every path reads the
 * token's decimals() at runtime - this module contains no decimals literal.
 */
export class PayoutRouter {
  private readonly deps: PayoutRouterDeps;

  constructor(deps: PayoutRouterDeps) {
    this.deps = deps;
  }

  /**
   * Route `amount` (USDC base units) to `config.payee` in the payee's configured
   * asset. The asset comes from `config` only - there is no caller override.
   *
   * @param config The per-payee config carrying the (non-caller-controlled) asset.
   * @param amount The payout amount in USDC base units.
   * @param bounds Optional slippage / min-out bounds for the EURC swap leg. Ignored
   *   on the USDC straight-through path (no swap happens there).
   */
  async route(config: PayeeConfig, amount: bigint, bounds?: SwapBounds): Promise<PayoutResult> {
    if (isEurc(config)) {
      // EURC path (per-payee opt-in): route the USDC amount through StableFX, then
      // pay EURC. Both decimals() are read at runtime (never hardcoded).
      //
      // DECIMALS-EQUALITY ASSERTION: the incoming `amount` is in USDC base units and
      // the swap is modeled as a base-unit-in / base-unit-out transform, which is
      // only sound when USDC and EURC share the same decimals. Both are documented as
      // 6dp on Arc, but we do NOT assume it: read decimals() of BOTH and refuse the
      // payout if they differ, rather than silently mis-scaling the amount across a
      // decimals boundary (CHAIN-03 / T-08-UNITCONFUSION).
      const usdcDecimals = await this.deps.decimalsReader.decimals(USDC);
      const eurcDecimals = await this.deps.decimalsReader.decimals(EURC);
      assertEqualDecimals(usdcDecimals, eurcDecimals);

      const quote = await this.deps.fx.quote(USDC, EURC, amount);
      const outAmount = await this.deps.fx.swap(quote);
      // SLIPPAGE / MIN-OUT GATE: a hostile or buggy RFQ adapter controls both the
      // quote and the realized swap return, so the swap output is never trusted
      // unbounded. Reject the payout when the realized swap (1) falls below the
      // caller's declared floor (minOut / maxSlippageBps), or (2) falls below the
      // quoted outAmount beyond the accepted tolerance (the adapter must honor its
      // own quote). The default tolerance is zero: realized >= quoted.
      assertWithinSwapBounds(quote.outAmount, outAmount, bounds);
      const decimals = eurcDecimals;
      return {
        asset: "EURC",
        token: EURC,
        amount: outAmount,
        decimals,
        swapped: true,
      };
    }
    // USDC path (default): pay straight through, reading USDC decimals() at runtime.
    const decimals = await this.deps.decimalsReader.decimals(USDC);
    return {
      asset: "USDC",
      token: USDC,
      amount,
      decimals,
      swapped: false,
    };
  }
}

/** Narrow a payee config to the EURC opt-in branch (the settle() isExact() idiom). */
function isEurc(config: PayeeConfig): boolean {
  return config.asset === "EURC";
}

/**
 * Refuse the USDC<->EURC base-unit identity transform unless the two tokens share
 * decimals. The swap path treats a USDC base-unit amount as the EURC base-unit input
 * 1:1, which silently mis-scales the money if the tokens have different decimals. We
 * never assume both are 6dp; we read decimals() of each and require equality.
 */
function assertEqualDecimals(usdcDecimals: number, eurcDecimals: number): void {
  if (usdcDecimals !== eurcDecimals) {
    throw new Error(
      "PayoutRouter: refusing the EURC swap - USDC and EURC report different " +
        `decimals (USDC=${usdcDecimals}, EURC=${eurcDecimals}); the base-unit ` +
        "identity transform is only sound when the decimals are equal",
    );
  }
}

/**
 * Reject a swap whose realized output is unacceptable. Two independent floors apply:
 *
 *   (1) The caller's declared floor. `minOut` is an absolute base-unit floor;
 *       `maxSlippageBps` is a tolerance below the quote. When both are given the
 *       stricter (higher) floor wins. The realized swap must be at or above it.
 *   (2) The quote-reconciliation floor. The adapter must honor the quote it just
 *       produced: the realized swap must be at least quote.outAmount, less the
 *       caller-accepted slippage tolerance (zero by default).
 *
 * Either breach throws before the payout is returned, so a hostile/buggy RFQ adapter
 * cannot deliver less than the payee agreed to accept.
 *
 * @param quotedOut The base-unit outAmount the adapter quoted.
 * @param realizedOut The base-unit amount the swap actually returned.
 * @param bounds The caller's optional slippage / min-out bounds.
 */
function assertWithinSwapBounds(
  quotedOut: bigint,
  realizedOut: bigint,
  bounds?: SwapBounds,
): void {
  // The tolerance the caller accepts below the quote (0 bps = realized must meet the
  // quote exactly). Reject a nonsensical bps so a caller cannot disable the gate.
  const bps = bounds?.maxSlippageBps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || BigInt(bps) > BPS_DENOMINATOR) {
    throw new Error(
      "PayoutRouter: invalid maxSlippageBps (must be an integer in [0, 10000])",
    );
  }

  // (2) Quote-reconciliation floor: the adapter must honor its own quote within the
  // accepted tolerance. floor = quotedOut * (10000 - bps) / 10000.
  const quoteFloor = (quotedOut * (BPS_DENOMINATOR - BigInt(bps))) / BPS_DENOMINATOR;

  // (1) Caller's absolute floor (if any) combined with the quote floor: the realized
  // swap must clear the strictest of every floor that applies.
  let floor = quoteFloor;
  if (bounds?.minOut !== undefined && bounds.minOut > floor) {
    floor = bounds.minOut;
  }

  if (realizedOut < floor) {
    throw new Error(
      "PayoutRouter: refusing the payout - the realized swap output " +
        `(${realizedOut}) is below the accepted minimum (${floor}); the StableFX ` +
        "adapter under-delivered against the quote or the payee's min-out bound",
    );
  }
}
