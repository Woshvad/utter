// PayoutHistoryPanel.tsx - the unified creator PAYOUT LEDGER (money in + money out).
//
// This is the historical record of the creator's money movement, distinct from the two
// existing surfaces: RevenuePanel shows aggregate revenue and EarningsWithdrawCard shows
// the LIVE withdrawable balance. This panel shows the LEDGER:
//   - withdrawals (out): the connected creator's real on-chain PaymentEscrow.Withdrawn
//     events, read via usePayoutHistory (a client-only chain read that bypasses the
//     StudioDataAdapter like the sibling read hooks - so in fixture mode this group is
//     empty/loading by design, the documented client-hook fixture gap).
//   - settlements (in): the settle/refund receipts the dashboard loader ALREADY fetches
//     via getRevenue, reused here (no re-derivation, no facilitator change).
//
// Settles carry no ordering metadata, so the two sides are presented as honest labeled
// groups, never faked into one merged chronological sort.
//
// Money discipline: every amount is a base-unit bigint rendered ONLY through the single
// UsdcAmount surface, with the runtime decimals (the withdrawals read's own decimals when
// resolved, else the SSR fallback). There is NO 6/1e6 money literal here. Links reuse TxLink.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { TxLink } from "../primitives/TxLink";
import { usePayoutHistory } from "../../wallet/usePayoutHistory.js";
import type { RevenueReceipt } from "../../adapter/types";

export interface PayoutHistoryPanelProps {
  /** The connected creator address; the client hook reads its withdrawals (money out). */
  address?: string;
  /** The settle/refund receipts from the loader's existing getRevenue read (money in). */
  settles: RevenueReceipt[];
  /** The ARC_EXPLORER base for the TxLinks. */
  explorer: string;
  /** SSR fallback runtime decimals, used until the withdrawals read resolves its own. */
  decimals: number;
}

export function PayoutHistoryPanel({
  address,
  settles,
  explorer,
  decimals,
}: PayoutHistoryPanelProps): React.ReactElement {
  // The real on-chain withdrawals (money out) for the connected creator.
  const history = usePayoutHistory({ address });
  // Prefer the runtime-read decimals; fall back to the passed SSR decimals.
  const renderDecimals = history.decimals ?? decimals;
  const records = history.records ?? [];

  return (
    <section
      data-testid="payout-history-panel"
      className="mb-[16px] flex flex-col gap-[16px] border border-hairline bg-raised p-[24px]"
    >
      <span className="font-mono text-[12px] tracking-[0.06em] text-ink-faint">
        PAYOUT HISTORY
      </span>

      {/* WITHDRAWN (out): the real on-chain Withdrawn events, newest-first. */}
      <div className="flex flex-col gap-[8px]">
        <span className="font-mono text-[11px] tracking-[0.04em] text-ink-faint lowercase">
          withdrawn
        </span>
        {!address ? (
          <div data-testid="payout-disconnected" className="font-mono text-caption-mono text-ink-faint lowercase">
            connect a wallet to see withdrawals
          </div>
        ) : history.loading ? (
          <div data-testid="payout-withdrawals-loading" className="font-mono text-caption-mono text-ink-muted lowercase">
            loading withdrawals…
          </div>
        ) : history.error ? (
          <div data-testid="payout-withdrawals-error" className="font-mono text-caption-mono text-ink-muted lowercase">
            withdrawals unavailable
          </div>
        ) : records.length === 0 ? (
          <div data-testid="payout-withdrawals-empty" className="font-mono text-caption-mono text-ink-faint lowercase">
            no withdrawals yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-[8px]">
            {records.map((r) => (
              <li
                key={r.tx}
                data-testid="payout-row"
                data-kind="withdraw"
                className="flex items-center justify-between gap-[12px]"
              >
                <span className="font-mono text-caption-mono text-ink lowercase">withdraw</span>
                <UsdcAmount baseUnits={r.amount} decimals={renderDecimals} className="text-ink" />
                <TxLink hash={r.tx} explorer={explorer} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* EARNED / SETTLEMENTS (in): the loader's getRevenue receipts, reused. */}
      <div className="flex flex-col gap-[8px]">
        <span className="font-mono text-[11px] tracking-[0.04em] text-ink-faint lowercase">
          earned · settlements
        </span>
        {settles.length === 0 ? (
          <div data-testid="payout-settles-empty" className="font-mono text-caption-mono text-ink-faint lowercase">
            no settlements yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-[8px]">
            {settles.map((r) => (
              <li
                key={r.tx}
                data-testid="payout-row"
                data-kind={r.kind}
                className="flex items-center justify-between gap-[12px]"
              >
                <span className="font-mono text-caption-mono text-ink lowercase">{r.kind}</span>
                <UsdcAmount
                  baseUnits={r.amount}
                  decimals={renderDecimals}
                  className={r.kind === "settle" ? "text-yellow" : "text-ink-muted"}
                />
                <TxLink hash={r.tx} explorer={explorer} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
