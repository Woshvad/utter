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
  constructor(private readonly deps: PayoutRouterDeps) {}

  /**
   * Route `amount` (USDC base units) to `config.payee` in the payee's configured
   * asset. The asset comes from `config` only - there is no caller override.
   *
   * @param config The per-payee config carrying the (non-caller-controlled) asset.
   * @param amount The payout amount in USDC base units.
   */
  async route(config: PayeeConfig, amount: bigint): Promise<PayoutResult> {
    if (isEurc(config)) {
      // EURC path (per-payee opt-in): route the USDC amount through StableFX, then
      // pay EURC. The EURC decimals() is read at runtime (never hardcoded).
      const quote = await this.deps.fx.quote(USDC, EURC, amount);
      const outAmount = await this.deps.fx.swap(quote);
      const decimals = await this.deps.decimalsReader.decimals(EURC);
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
