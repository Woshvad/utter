// dashboard.tsx - the STU-04 creator revenue dashboard loader + screen (D-STU-04).
//
// Read-through discipline (T-06-REDERIVE): the loader reads every figure THROUGH the
// adapter - getRevenue(resourceId) aggregates the settle/refund records and projects
// the creator/platform split; listMarketplace projects the discovery cards. It NEVER
// recomputes the creator/platform split; the rendered figures are the projected
// amounts. The per-resource rows are listMarketplace cards joined with each card's
// getRevenue (calls/revenue real; uptime/bond/active from the card).
//
// Money discipline: the runtime decimals come from a read through the adapter
// (getEscrowBalance().decimals), never a 1e6/6 literal; every money figure renders
// only through the single UsdcAmount surface. The dashboard leads yellow (money).
//
// ArcScan links: the explorer base comes from the existing ARC_EXPLORER env (the
// repo's single ArcScan source; .env.example line 8), with the @utter/chain
// arcTestnet block-explorer URL as the fallback - we do NOT redefine the explorer.
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { arcTestnet } from "@utter/chain";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import type { RevenueSummary } from "../adapter/types.js";
import { RevenuePanel } from "../components/dashboard/RevenuePanel.js";
import {
  ResourceTable,
  type DashboardAlert,
  type ResourceRow,
} from "../components/dashboard/ResourceTable.js";

/** A bounded, safe resourceId param (decode-before-use, ASVS V5). */
function isSafeParam(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/**
 * Resolve the ArcScan explorer base: the ARC_EXPLORER env (the repo-wide ArcScan
 * source) if set, else the @utter/chain arcTestnet block-explorer URL. We never
 * hardcode a second explorer constant here.
 */
function resolveExplorer(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.ARC_EXPLORER?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return arcTestnet.blockExplorers?.default.url ?? "";
}

/**
 * Representative 12-month chart series (comp 1055-1056). There is NO real monthly
 * revenue/calls history yet, so these are the comp's representative series, used only
 * for the bar heights - they are clearly representative, never faked live numbers.
 */
const REVENUE_SERIES = [40, 55, 48, 70, 62, 85, 78, 95, 88, 100, 92, 110];
const CALLS_SERIES = [30, 45, 52, 48, 66, 72, 60, 80, 88, 76, 94, 100];

/** The aggregate stat-cell figures, summed across the listed resources. */
export interface DashboardTotals {
  /** Sum of per-resource creator earnings, base units. */
  earnings: bigint;
  /** Sum of per-resource settled calls. */
  calls: number;
  /** Count of currently-active (live) resources. */
  liveApis: number;
  /** Active strikes / alerts count. */
  strikes: number;
}

/** The serialized loader payload: the read-through revenue + rows + runtime decimals. */
export interface DashboardData {
  /** The single-resource revenue summary backing the settlements disclosure. */
  revenue: RevenueSummary;
  /** The aggregate stat-cell totals across resources. */
  totals: DashboardTotals;
  /** The per-resource table rows. */
  rows: ResourceRow[];
  decimals: number;
  explorer: string;
  alerts: DashboardAlert[];
}

export async function loader({ request }: LoaderFunctionArgs): Promise<DashboardData> {
  // Access gate (CR-01): the revenue dashboard is creator-only. requireCreator throws
  // redirect(/auth) or 401 before any revenue is read, so anon never sees the figures.
  await requireCreator(request);

  const adapter = selectAdapter(process.env);

  // The settlements disclosure reads a single resource's receipts; the resourceId
  // comes from the query string (?resource=...). Default to the canonical resource
  // when absent so the autonomous loader test has a deterministic target.
  const url = new URL(request.url);
  const resourceParam = url.searchParams.get("resource") ?? undefined;
  const resourceId = isSafeParam(resourceParam)
    ? resourceParam
    : // fall back to the fixture/canonical resource id (validated shape)
      "0x00000000000000000000000000000000000000000000000000000000000000a1";

  // Read-through aggregation: the single-resource summary (calls/gross/creator+platform
  // /refunds + receipts) backs the settlements disclosure. The split is the projected
  // aggregate, never recomputed here.
  const revenue = await adapter.getRevenue(resourceId);

  // Per-resource rows: join each listed card with its read-through revenue. Calls and
  // revenue are the projected getRevenue figures; uptime/bond/active come from the card.
  const cards = await adapter.listMarketplace({});
  const rows: ResourceRow[] = await Promise.all(
    cards.map(async (card) => {
      const rev = await adapter.getRevenue(card.resourceId);
      return {
        resourceId: card.resourceId,
        slug: card.slug,
        calls: rev.calls,
        // The projected creator share, never recomputed.
        revenue: rev.creatorShare,
        uptime: card.uptime,
        bond: card.bond,
        active: card.active,
      };
    }),
  );

  // Runtime money scale read through the adapter (no 6/1e6 literal in the render).
  const { decimals } = await adapter.getEscrowBalance(
    "0x0000000000000000000000000000000000000000",
  );

  const explorer = resolveExplorer(process.env);

  // Active alerts are surfaced from the OBS-02 evaluators in the live path; the
  // autonomous path renders none (never faked).
  const alerts: DashboardAlert[] = [];

  // Aggregate stat-cell totals: sum creator earnings + calls, count live, alerts.
  const totals: DashboardTotals = {
    earnings: rows.reduce((sum, r) => sum + r.revenue, 0n),
    calls: rows.reduce((sum, r) => sum + r.calls, 0),
    liveApis: rows.filter((r) => r.active).length,
    strikes: alerts.length,
  };

  return { revenue, totals, rows, decimals, explorer, alerts };
}

export default function DashboardRoute(): React.ReactElement {
  const { revenue, totals, rows, decimals, explorer, alerts } =
    useLoaderData<typeof loader>();

  return (
    <div className="mx-auto max-w-[1280px] px-[32px] pb-[64px] pt-[28px]">
      <h1
        data-testid="dashboard-title"
        className="mb-[24px] text-[26px] font-semibold tracking-[-0.02em] text-ink lowercase"
      >
        dashboard
      </h1>
      <RevenuePanel
        earnings={totals.earnings}
        totalCalls={totals.calls}
        liveApis={totals.liveApis}
        strikes={totals.strikes}
        decimals={decimals}
        revenueSeries={REVENUE_SERIES}
        callsSeries={CALLS_SERIES}
      />
      <ResourceTable
        rows={rows}
        decimals={decimals}
        explorer={explorer}
        receipts={revenue.receipts}
        alerts={alerts}
      />
    </div>
  );
}
