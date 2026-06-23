// ResourceTable - the STU-04 dashboard resources table (comp 665-682).
//
// The resting view matches the comp: a card with a "YOUR RESOURCES" header + a yellow
// "withdraw earnings" button, a 5-column grid (RESOURCE / CALLS / REVENUE / UPTIME /
// BOND), and one row per resource - a 9px status circle (red when live) + the slug,
// then calls / revenue (yellow, UsdcAmount) / uptime / bond. Each row links to
// /resources/<id>. Every money figure renders through the single UsdcAmount surface
// (no 1e6/6/18 literal); the revenue shown is the projected read-through creator
// share, never recomputed here.
//
// KEEP FUNCTION: the ArcScan receipt links + alerts are an existing feature the comp
// table does not show. They are preserved below the table in a collapsed "recent
// settlements" <details> disclosure (TxLink to ArcScan + the alert lines), so the
// resting dashboard matches the comp but the ArcScan access is not lost.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { TxLink } from "../primitives/TxLink";
import type { RevenueReceipt } from "../../adapter/types";

/** A dashboard alert line (from the OBS-02 alert evaluators, surfaced for the creator). */
export interface DashboardAlert {
  /** A stable kind discriminator. */
  kind: string;
  /** A short, non-secret human message. */
  message: string;
}

/** One per-resource row of the dashboard table (projected read-through). */
export interface ResourceRow {
  /** The on-chain resourceId (links to /resources/<id>). */
  resourceId: string;
  /** The discovery slug (the row name). */
  slug: string;
  /** Total settled calls for this resource. */
  calls: number;
  /** The projected creator revenue, base units (read-through, not recomputed). */
  revenue: bigint;
  /** The rolling 0..1 uptime/health from the card. */
  uptime: number;
  /** The posted bond, base units, from the card. */
  bond: bigint;
  /** Whether the resource is currently live/active (drives the red status circle). */
  active: boolean;
}

export interface ResourceTableProps {
  /** The per-resource rows (read through listMarketplace + getRevenue). */
  rows: ResourceRow[];
  /** Runtime USDC decimals (the ONLY scale; from readUsdcBalance). */
  decimals: number;
  /** The ArcScan/Blockscout base URL (from ARC_EXPLORER) for the receipt links. */
  explorer: string;
  /** The settle/refund receipt rows (kept reachable in the disclosure). */
  receipts: RevenueReceipt[];
  /** Active alerts to surface in the disclosure (may be empty). */
  alerts?: DashboardAlert[];
}

const COL = "grid grid-cols-[2fr_1.2fr_1.2fr_1fr_0.8fr]";

/** Format a 0..1 uptime as the comp's percent (paused-safe). */
function formatUptime(uptime: number, active: boolean): string {
  if (!active) return "paused";
  return `${(uptime * 100).toFixed(uptime >= 1 ? 0 : 2)}%`;
}

export function ResourceTable({
  rows,
  decimals,
  explorer,
  receipts,
  alerts = [],
}: ResourceTableProps): React.ReactElement {
  return (
    <section data-testid="resource-table">
      <div className="border border-hairline bg-raised">
        {/* header: title + the yellow withdraw-earnings action (comp 666-669) */}
        <div className="flex items-center justify-between border-b border-hairline p-[16px_18px]">
          <span className="font-mono text-[12px] tracking-[0.06em] text-ink-faint">
            YOUR RESOURCES
          </span>
          <a
            href="/wallet"
            data-testid="withdraw-earnings"
            className="bg-yellow px-[16px] py-[8px] font-mono text-[13px] font-bold text-paper-ink"
          >
            withdraw earnings
          </a>
        </div>

        {/* column header (comp 670-672) */}
        <div
          className={`${COL} border-b border-hairline p-[10px_18px] font-mono text-[11px] tracking-[0.04em] text-ink-faint`}
        >
          <div>RESOURCE</div>
          <div className="text-right">CALLS</div>
          <div className="text-right">REVENUE</div>
          <div className="text-right">UPTIME</div>
          <div className="text-right">BOND</div>
        </div>

        {/* rows (comp 673-681) - each links to /resources/<id> */}
        {rows.length === 0 ? (
          <div data-testid="resource-table-empty" className="p-[14px_18px] text-body text-ink-muted lowercase">
            no resources yet.
          </div>
        ) : (
          rows.map((row) => (
            <a
              key={row.resourceId}
              href={`/resources/${row.resourceId}`}
              data-testid="resource-row"
              className={`${COL} items-center border-b border-hairline p-[14px_18px]`}
            >
              <div className="flex items-center gap-[10px]">
                <span
                  aria-hidden="true"
                  className="h-[9px] w-[9px] flex-none rounded-full"
                  style={{ background: row.active ? "var(--red)" : "var(--ink-faint)" }}
                />
                <span className="font-mono text-[13px]">{row.slug}</span>
              </div>
              <div className="text-right font-mono text-[13px] text-ink-muted">
                {row.calls.toLocaleString("en-US")}
              </div>
              <div className="text-right font-mono text-[13px] text-yellow">
                <UsdcAmount baseUnits={row.revenue} decimals={decimals} />
              </div>
              <div className="text-right font-mono text-[13px] text-ink-muted">
                {formatUptime(row.uptime, row.active)}
              </div>
              <div className="text-right font-mono text-[13px] text-ink-muted">
                <UsdcAmount baseUnits={row.bond} decimals={decimals} />
              </div>
            </a>
          ))
        )}
      </div>

      {/* KEEP FUNCTION: ArcScan receipts + alerts in a collapsed disclosure below the
          table, so the resting view matches the comp but the access is not lost. */}
      <details data-testid="recent-settlements" className="mt-[16px] border border-hairline bg-raised">
        <summary className="cursor-pointer p-[12px_18px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
          recent settlements
        </summary>
        <div className="border-t border-hairline p-[12px_18px]">
          {receipts.length === 0 ? (
            <div data-testid="settlements-empty" className="font-mono text-caption-mono text-ink-faint lowercase">
              no settlements yet.
            </div>
          ) : (
            <ul className="flex flex-col gap-[8px]">
              {receipts.map((r) => (
                <li
                  key={r.tx}
                  data-testid="receipt-row"
                  data-kind={r.kind}
                  className="flex items-center justify-between gap-[12px]"
                >
                  <span className="font-mono text-caption-mono text-ink lowercase">{r.kind}</span>
                  <UsdcAmount baseUnits={r.amount} decimals={decimals} />
                  <TxLink hash={r.tx} explorer={explorer} />
                </li>
              ))}
            </ul>
          )}

          {alerts.length > 0 ? (
            <ul className="mt-[12px] flex flex-col gap-[8px]">
              {alerts.map((a) => (
                <li
                  key={a.kind}
                  data-testid="alert-row"
                  className="flex items-center gap-[8px] border-l-2 border-red pl-[8px]"
                >
                  <span
                    aria-hidden="true"
                    className="h-[9px] w-[9px] flex-none"
                    style={{ background: "var(--red)" }}
                  />
                  <span className="font-mono text-caption-mono text-ink">{a.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </section>
  );
}
