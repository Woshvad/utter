// PaywallSheet - the designed 402 paywall beat (UI-SPEC §Paywall / §Motion).
//
// This is NOT an error: a red bar slides in (the `utterBar` keyframe), the mono price is
// read STRAIGHT FROM the accepts quote (maxAmountRequired - never recomputed,
// T-06-REDERIVE), and the buyer either "pays from balance" (funded) or "deposits & pays"
// (unfunded). After onPay the result streams (the player swaps the sheet for the
// response). Money renders only through UsdcAmount; the cap is the quote's
// maxAmountRequired in base units and the decimals format comes from the runtime-read
// `decimals` prop (NO 1e6/6 literal).
import * as React from "react";
import type { AcceptsEntry } from "@utter/x402-arc";
import { UsdcAmount } from "../primitives/UsdcAmount.js";

export interface PaywallSheetProps {
  /** The 402 accepts entry (the escrow quote) - the SOLE price source. */
  quote: AcceptsEntry;
  /** Decimals from a runtime read (the only scale source). */
  decimals: number;
  /** Whether the buyer already has an escrow balance to pay from. */
  funded: boolean;
  /** Invoked when the buyer confirms the pay (then the result streams). */
  onPay: () => void;
}

export function PaywallSheet({
  quote,
  decimals,
  funded,
  onPay,
}: PaywallSheetProps): React.ReactElement {
  // The cap (price) is read straight off the quote - never recomputed. Escrow entries
  // carry maxAmountRequired (the signed cap); fall back to the exact `amount` if present.
  const capStr = quote.maxAmountRequired ?? quote.amount ?? "0";
  const cap = BigInt(capStr);
  const isMetered = quote.scheme === "utter-escrow" && quote.pricing !== undefined;

  return (
    <div
      data-testid="paywall-sheet"
      role="dialog"
      aria-label="payment required"
      className="flex flex-col gap-md border border-red bg-raised"
    >
      {/* the red bar slides in (utterBar) - the 402 beat, not an error chrome */}
      <div
        data-testid="paywall-bar"
        className="flex items-center gap-sm bg-red px-md py-xs text-paper"
        style={{ animation: "utterBar 180ms ease-out" }}
      >
        {/* shape marker so the beat is not color-only (a11y): a paper square */}
        <span aria-hidden="true" className="inline-block h-3 w-3 bg-paper" />
        <span className="font-display text-label lowercase">payment required · 402</span>
      </div>

      <div className="flex flex-col gap-sm px-md pb-md">
        <div className="flex items-baseline gap-xs">
          <span className="font-display text-label text-ink-muted lowercase">
            {isMetered ? "up to" : "price"}
          </span>
          <span className="font-mono text-heading text-ink">
            <UsdcAmount baseUnits={cap} decimals={decimals} />
          </span>
          {isMetered ? (
            <span className="font-mono text-caption-mono text-ink-faint lowercase">per call (metered, capped)</span>
          ) : null}
        </div>

        <button
          type="button"
          data-testid="paywall-pay"
          onClick={onPay}
          className="min-h-[44px] self-start border border-red bg-red px-md py-xs font-display text-label text-paper lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          {funded ? "pay from balance" : "deposit & pay"}
        </button>
      </div>
    </div>
  );
}
