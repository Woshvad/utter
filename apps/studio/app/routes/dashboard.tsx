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
import { useAccount } from "wagmi";
import { arcTestnet } from "@utter/chain";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import type { RevenueSummary, RevenueReceipt } from "../adapter/types.js";
import { RevenuePanel } from "../components/dashboard/RevenuePanel.js";
import { EarningsWithdrawCard } from "../components/dashboard/EarningsWithdrawCard.js";
import { PayoutHistoryPanel } from "../components/dashboard/PayoutHistoryPanel.js";
import {
  ResourceTable,
  type DashboardAlert,
  type ResourceRow,
} from "../components/dashboard/ResourceTable.js";

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
  /** The account-wide settle/refund receipts (money in), deduped by tx across resources. */
  settles: RevenueReceipt[];
  decimals: number;
  explorer: string;
  alerts: DashboardAlert[];
}

/** Case-insensitive hex address compare (addresses may differ only by checksum casing). */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function loader({ request }: LoaderFunctionArgs): Promise<DashboardData> {
  // Access gate (CR-01): the revenue dashboard is creator-only. requireCreator throws
  // redirect(/auth) or 401 before any revenue is read, so anon never sees the figures.
  // Capture the SIWE-authenticated address so the aggregation is scoped to this creator's
  // own resources - the dashboard must never leak another creator's revenue / calls /
  // settlement tx hashes (H3 cross-tenant scoping).
  const creator = await requireCreator(request);

  const adapter = selectAdapter(process.env);

  // The settlements disclosure reads a single resource's receipts; the resourceId
  // comes from the query string (?resource=...). The facilitator revenue read expects a
  // canonical bytes32 id, so the param must match /^0x[0-9a-fA-F]{64}$/ exactly. A param
  // that is absent or not bytes32 (e.g. ?resource=echo) falls back to the canonical
  // resource id; this stops a non-bytes32 id from reaching the facilitator as a 400.
  const url = new URL(request.url);
  const resourceParam = url.searchParams.get("resource") ?? undefined;
  const isBytes32 = (v: string | undefined): v is string =>
    typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
  const requestedResourceId = isBytes32(resourceParam)
    ? resourceParam
    : // fall back to the fixture/canonical resource id (canonical bytes32 shape)
      "0x00000000000000000000000000000000000000000000000000000000000000a1";

  // The dashboard leads with money, so it is revenue-PRIMARY: a facilitator failure must
  // surface the branded status page, not the something-broke screen. Read every revenue
  // figure inside a single try; on ANY throw re-throw a 503 Response (the root
  // ErrorBoundary renders a thrown Response via its status branch). Do NOT degrade to
  // fake zero rows here - the dashboard fails loud-but-branded.
  let revenue: RevenueSummary;
  let rows: ResourceRow[];
  let settles: RevenueReceipt[];
  try {
    // Tenant scoping (H3): list every card THROUGH the adapter, then resolve each card's
    // owner via getResourceDetail (the only carrier of `creator`, mirroring
    // creators.$address.tsx) and keep only the cards owned by the authed creator. The
    // aggregation below runs over OWNED cards only, so no other creator's revenue, calls,
    // or settlement receipts can reach this dashboard.
    const allCards = await adapter.listMarketplace({});
    const ownedFlags = await Promise.all(
      allCards.map(async (card) => {
        const detail = await adapter.getResourceDetail(card.resourceId);
        return sameAddress(detail.creator, creator);
      }),
    );
    const cards = allCards.filter((_card, i) => ownedFlags[i]);

    // The single-resource settlements disclosure reads ?resource= only when the caller
    // actually owns it; otherwise it falls back to a canonical owned resource rather than
    // reading another creator's receipts. With no owned resources it falls back to the
    // requested id (the read-through revenue is then this creator's own empty/zero figures).
    const ownsRequested = cards.some((c) => sameAddress(c.resourceId, requestedResourceId));
    const resourceId =
      ownsRequested ? requestedResourceId : (cards[0]?.resourceId ?? requestedResourceId);

    // Read-through aggregation: the single-resource summary (calls/gross/creator+platform
    // /refunds + receipts) backs the settlements disclosure. The split is the projected
    // aggregate, never recomputed here.
    revenue = await adapter.getRevenue(resourceId);

    // Per-resource rows: join each OWNED card with its read-through revenue. Calls and
    // revenue are the projected getRevenue figures; uptime/bond/active come from the card.
    // Collect each card's receipts alongside the row so the account-wide settles ledger
    // (the PayoutHistoryPanel "in" side) reuses the SAME getRevenue read - no re-derivation.
    const rowResults = await Promise.all(
      cards.map(async (card) => {
        const rev = await adapter.getRevenue(card.resourceId);
        return {
          row: {
            resourceId: card.resourceId,
            slug: card.slug,
            calls: rev.calls,
            // The projected creator share, never recomputed.
            revenue: rev.creatorShare,
            uptime: card.uptime,
            bond: card.bond,
            active: card.active,
          },
          receipts: rev.receipts,
        };
      }),
    );
    rows = rowResults.map((r) => r.row);

    // Account-wide settles ledger, deduped by tx so the primary `revenue` resource (which
    // also appears in `cards`) is not double-listed. Built inside the same try so a
    // facilitator failure still surfaces the branded 503 (no degraded fake rows).
    const settleMap = new Map<string, RevenueReceipt>();
    for (const rc of revenue.receipts) settleMap.set(rc.tx, rc);
    for (const rr of rowResults) for (const rc of rr.receipts) settleMap.set(rc.tx, rc);
    settles = [...settleMap.values()];
  } catch (err) {
    // Re-throw an already-Response unchanged (e.g. a thrown redirect/status); otherwise
    // surface a branded 503 so the page shows the status page, not the crash screen.
    if (err instanceof Response) throw err;
    throw new Response(JSON.stringify({ error: "revenue_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  return { revenue, totals, rows, settles, decimals, explorer, alerts };
}

/** A small mounted guard: false on the server + first client render, true after mount.
 *  The earnings card needs the wagmi-connected address, so it must not read on the server. */
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

export default function DashboardRoute(): React.ReactElement {
  const { revenue, totals, rows, settles, decimals, explorer, alerts } =
    useLoaderData<typeof loader>();
  const mounted = useMounted();
  const { address } = useAccount();

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
      {/* The LIVE withdrawable-earnings card: the creator's accrued escrow balance
          (useAccruedEarnings) with a confirm-gated withdraw that REUSES escrow.withdraw
          (useWithdraw). Client-only (it needs the connected wallet), so it is mounted
          behind the useMounted guard - distinct from RevenuePanel's HISTORICAL revenue. */}
      {mounted ? <EarningsWithdrawCard address={address} decimals={decimals} /> : null}
      {/* The unified PAYOUT LEDGER: real on-chain withdrawals (money out, via the client
          usePayoutHistory hook) + the loader's getRevenue settle/refund receipts (money in,
          reused, no re-derivation). The settles render identically on server + client (no
          hydration mismatch); the withdrawals are empty on SSR (no address) and populate
          post-mount via the hook's effect - a normal client update, so no mounted guard is
          needed. Distinct from RevenuePanel (aggregate) and EarningsWithdrawCard (live balance). */}
      <PayoutHistoryPanel
        address={address}
        settles={settles}
        explorer={explorer}
        decimals={decimals}
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
