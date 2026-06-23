// PaywallSheet - the designed 402 paywall beat (UI-SPEC §Paywall / §Motion).
//
// This is NOT an error: an ABSOLUTE overlay mounts over the (relative) player frame -
// a scrim (rgba(0,0,0,.72)) with a bottom-anchored sheet whose red 4px top border bar
// slides in (the `utterBar` keyframe). The mono price is read STRAIGHT FROM the accepts
// quote (maxAmountRequired - never recomputed, T-06-REDERIVE), and the buyer either
// "pays from balance" (pay-from-balance triggers onPay -> the wallet pay seam) or
// "deposits & pays" (-> /wallet). After onPay the result streams (the player swaps the
// overlay for the response). Money renders only through UsdcAmount; the cap is the
// quote's maxAmountRequired in base units and the decimals format comes from the
// runtime-read `decimals` prop (NO 1e6/6 literal).
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
  /** Invoked when the buyer cancels (the overlay closes; optional). */
  onCancel?: () => void;
}

export function PaywallSheet({
  quote,
  decimals,
  funded,
  onPay,
  onCancel,
}: PaywallSheetProps): React.ReactElement {
  // The cap (price) is read straight off the quote - never recomputed. Escrow entries
  // carry maxAmountRequired (the signed cap); fall back to the exact `amount` if present.
  const capStr = quote.maxAmountRequired ?? quote.amount ?? "0";
  const cap = BigInt(capStr);

  return (
    <div
      data-testid="paywall-sheet"
      role="dialog"
      aria-label="payment required"
      className="absolute inset-0 flex items-end"
      style={{ background: "rgba(0,0,0,0.72)" }}
    >
      {/* the bottom-anchored sheet: red 4px top border, the utterBar slide-in */}
      <div className="w-full border-t-[4px] border-red bg-raised animate-utter-bar">
        {/* the 402 red bar - the beat marker, not error chrome */}
        <div
          data-testid="paywall-bar"
          className="bg-red px-[18px] py-[8px] font-mono text-[12px] font-bold tracking-[0.06em] text-white"
        >
          402 · PAYMENT REQUIRED
        </div>

        <div className="flex flex-wrap items-center gap-[20px] px-[18px] py-[22px]">
          <div className="min-w-[200px] flex-1">
            <div className="mb-[4px] text-[18px] font-semibold text-ink lowercase">
              pay to run this call
            </div>
            <div className="font-mono text-[13px] text-ink-muted lowercase">
              {"metered, capped at "}
              <span className="text-yellow">
                <UsdcAmount baseUnits={cap} decimals={decimals} />
              </span>
              {" · settles in usdc on arc"}
            </div>
          </div>

          <button
            type="button"
            data-testid="paywall-pay"
            onClick={onPay}
            className="bg-red px-[22px] py-[13px] font-mono text-[14px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            {"pay "}
            <UsdcAmount baseUnits={cap} decimals={decimals} />
            {" from balance"}
          </button>

          <a
            href="/wallet"
            data-testid="paywall-deposit"
            className="border border-hairline bg-transparent px-[22px] py-[13px] font-mono text-[14px] text-ink lowercase"
          >
            deposit & pay
          </a>

          <button
            type="button"
            data-testid="paywall-cancel"
            onClick={() => onCancel?.()}
            className="cursor-pointer font-mono text-[13px] text-ink-faint lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}
