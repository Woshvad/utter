// ResourceTable - the STU-04 dashboard's rule-separated settle/refund table with an
// alerts panel. Each row renders: a square StatusDot (resource/block motif), the
// receipt kind, the amount mono via UsdcAmount (6dp-aware, no literal), and a TxLink
// to ArcScan built from the explorer base + the receipt's tx hash. The split shown in
// RevenuePanel is the projected aggregate; this table lists the underlying receipts
// read THROUGH the facilitator stores - it never recomputes a receipt amount.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { StatusDot } from "../primitives/StatusDot";
import { TxLink } from "../primitives/TxLink";
import type { RevenueReceipt } from "../../adapter/types";

/** A dashboard alert line (from the OBS-02 alert evaluators, surfaced for the creator). */
export interface DashboardAlert {
  /** A stable kind discriminator. */
  kind: string;
  /** A short, non-secret human message. */
  message: string;
}

export interface ResourceTableProps {
  /** The settle/refund receipt rows (read through the facilitator stores). */
  receipts: RevenueReceipt[];
  /** Runtime USDC decimals (the ONLY scale; from readUsdcBalance). */
  decimals: number;
  /** The ArcScan/Blockscout base URL (from ARC_EXPLORER). */
  explorer: string;
  /** Active alerts to surface in the alerts panel (may be empty). */
  alerts?: DashboardAlert[];
}

export function ResourceTable({
  receipts,
  decimals,
  explorer,
  alerts = [],
}: ResourceTableProps): React.ReactElement {
  return (
    <section data-testid="resource-table" className="flex flex-col gap-lg">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-hairline">
            <th className="py-xs text-label font-display lowercase text-ink-muted">status</th>
            <th className="py-xs text-label font-display lowercase text-ink-muted">kind</th>
            <th className="py-xs text-right text-label font-display lowercase text-ink-muted">
              amount
            </th>
            <th className="py-xs text-right text-label font-display lowercase text-ink-muted">
              tx
            </th>
          </tr>
        </thead>
        <tbody>
          {receipts.length === 0 ? (
            <tr data-testid="resource-table-empty">
              <td colSpan={4} className="py-md text-body text-ink-muted lowercase">
                no settlements yet.
              </td>
            </tr>
          ) : (
            receipts.map((r) => (
              <tr
                key={r.tx}
                data-testid="receipt-row"
                data-kind={r.kind}
                className="border-b border-hairline"
              >
                <td className="py-xs">
                  {/* square = resource/block motif; refunds read as paused (yellow square) */}
                  <StatusDot state={r.kind === "refund" ? "paused" : "idle"} showLabel={false} />
                </td>
                <td className="py-xs font-mono text-caption-mono text-ink lowercase">{r.kind}</td>
                <td className="py-xs text-right">
                  <UsdcAmount baseUnits={r.amount} decimals={decimals} />
                </td>
                <td className="py-xs text-right">
                  <TxLink hash={r.tx} explorer={explorer} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* alerts panel: red square header, rule-separated alert lines */}
      <div data-testid="alerts-panel" className="flex flex-col gap-xs">
        <span className="text-label font-display lowercase text-ink-muted">alerts</span>
        {alerts.length === 0 ? (
          <span className="font-mono text-caption-mono text-ink-faint lowercase">
            no active alerts.
          </span>
        ) : (
          <ul className="flex flex-col gap-2xs">
            {alerts.map((a) => (
              <li
                key={a.kind}
                data-testid="alert-row"
                className="flex items-center gap-xs border-l-2 border-red pl-xs"
              >
                <StatusDot state="failed" showLabel={false} />
                <span className="font-mono text-caption-mono text-ink">{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
