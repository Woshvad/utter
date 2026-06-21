// stablefx-adapter.ts - the USDC<->EURC swap seam for EURC payouts (SCL-03).
//
// Mirrors packages/buyer-sdk/src/transport.ts EXACTLY: an injectable interface
// with a deterministic in-process default (MockStableFx - the autonomous path)
// and an operator-gated live half (LiveStableFx) that throws RequiresLiveStableFx.
// StableFX on Arc Testnet is an RFQ (request-for-quote) engine: a real swap needs
// an off-chain quote from a quote partner plus a funded EOA, so the live half is
// operator-gated and not run by the autonomous suite (08-RESEARCH Resolved Facts).
//
// All amounts are base-unit bigint. This module never encodes a decimals literal:
// the swap is a base-unit-in / base-unit-out transform; the decimals() read lives
// in payout-router.ts at the money boundary.
import type { Address } from "viem";
import { STABLEFX_FX_ESCROW } from "@utter/chain";

/** The StableFX FxEscrow that settles a live USDC<->EURC swap (pinned in @utter/chain). */
export const FX_ESCROW: Address = STABLEFX_FX_ESCROW;

/**
 * A StableFX quote: a base-unit `inAmount` of `from` for a base-unit `outAmount`
 * of `to`. The mock fills this deterministically; the live RFQ engine fills it
 * from an off-chain quote partner.
 */
export interface Quote {
  /** The asset paid in. */
  readonly from: Address;
  /** The asset received. */
  readonly to: Address;
  /** Base-unit amount paid in. */
  readonly inAmount: bigint;
  /** Base-unit amount received (the quoted swap output). */
  readonly outAmount: bigint;
}

/**
 * The swap seam: `quote()` prices a USDC<->EURC swap, `swap()` executes it and
 * returns the received base-unit amount. The injected implementation is the mock
 * default in the autonomous suite and the gated live adapter in production.
 */
export interface StableFxAdapter {
  /** A label for diagnostics (never logged to stdout). */
  readonly kind: "mock" | "live";
  /** Price a swap of `amount` base-units of `from` into `to`. */
  quote(from: Address, to: Address, amount: bigint): Promise<Quote>;
  /** Execute a quoted swap; resolves to the received base-unit amount. */
  swap(quote: Quote): Promise<bigint>;
}

/**
 * The deterministic autonomous default. A pass-through swap (1:1 base-unit ratio)
 * with no network - USDC and EURC are both 6dp on Arc, so a base-unit-preserving
 * mock is the honest deterministic fixture. The ratio is intentionally NOT a money
 * decimals literal: it is the identity transform on base units, which is what the
 * autonomous suite asserts (a deterministic, reproducible quote+swap).
 */
export class MockStableFx implements StableFxAdapter {
  readonly kind = "mock" as const;

  async quote(from: Address, to: Address, amount: bigint): Promise<Quote> {
    return { from, to, inAmount: amount, outAmount: amount };
  }

  async swap(quote: Quote): Promise<bigint> {
    return quote.outAmount;
  }
}

/**
 * The operator-gated fail-loud error for the live StableFX swap. Mirrors
 * RequiresLiveBuyerError (packages/buyer-sdk/src/transport.ts): a readonly `code`
 * discriminant + a message naming the missing off-chain RFQ quote partner and the
 * funded EOA. The live adapter is NEVER run by the autonomous suite.
 */
export class RequiresLiveStableFx extends Error {
  readonly code = "requiresLiveStableFx" as const;
  constructor() {
    super(
      "The live StableFX swap requires an off-chain RFQ quote partner and a funded " +
        "EOA in .env.local. StableFX on Arc Testnet is an RFQ engine: a real " +
        "USDC<->EURC swap broadcasts an irreversible on-chain settlement against " +
        "FxEscrow; it is operator-gated and not run autonomously.",
    );
    this.name = "RequiresLiveStableFx";
  }
}

/**
 * The live StableFX adapter. A real swap targets the StableFX FxEscrow on Arc with
 * an off-chain RFQ quote and a funded EOA. It is OPERATOR-GATED and fail-loud:
 * both `quote` and `swap` throw RequiresLiveStableFx so the autonomous suite can
 * never mistake it for a live run.
 */
export class LiveStableFx implements StableFxAdapter {
  readonly kind = "live" as const;

  async quote(_from: Address, _to: Address, _amount: bigint): Promise<Quote> {
    throw new RequiresLiveStableFx();
  }

  async swap(_quote: Quote): Promise<bigint> {
    throw new RequiresLiveStableFx();
  }
}
