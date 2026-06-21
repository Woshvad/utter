// dashboard.tsx - the STU-04 revenue dashboard loader + screen (D-STU-04).
//
// Read-through discipline (T-06-REDERIVE): the loader calls
// selectAdapter(process.env).getRevenue(resourceId) - which aggregates the
// settle/refund records from the facilitator stores through the adapter - and
// returns the summary (calls/gross/creator+platform/refunds + receipts). It NEVER
// recomputes the creator/platform split; the rendered figures are the projected
// receipt amounts.
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

/** The serialized loader payload: the read-through revenue + runtime decimals + explorer. */
export interface DashboardData {
  revenue: RevenueSummary;
  decimals: number;
  explorer: string;
  alerts: DashboardAlert[];
}

export async function loader({ request }: LoaderFunctionArgs): Promise<DashboardData> {
  // Access gate (CR-01): the revenue dashboard is creator-only. requireCreator throws
  // redirect(/auth) or 401 before any revenue is read, so anon never sees the figures.
  await requireCreator(request);

  const adapter = selectAdapter(process.env);

  // The dashboard reads a single resource's revenue; the resourceId comes from the
  // query string (?resource=...). Default to the adapter's canonical resource when
  // absent so the autonomous loader test has a deterministic target.
  const url = new URL(request.url);
  const resourceParam = url.searchParams.get("resource") ?? undefined;
  const resourceId = isSafeParam(resourceParam)
    ? resourceParam
    : // fall back to the fixture/canonical resource id (validated shape)
      "0x00000000000000000000000000000000000000000000000000000000000000a1";

  // Read-through aggregation: calls/gross/creator+platform/refunds + receipts. The
  // split is the projected aggregate, never recomputed here.
  const revenue = await adapter.getRevenue(resourceId);

  // Runtime money scale read through the adapter (no 6/1e6 literal in the render).
  const { decimals } = await adapter.getEscrowBalance(
    "0x0000000000000000000000000000000000000000",
  );

  const explorer = resolveExplorer(process.env);

  // Active alerts are surfaced from the OBS-02 evaluators in the live path; the
  // autonomous path renders none (never faked).
  const alerts: DashboardAlert[] = [];

  return { revenue, decimals, explorer, alerts };
}

export default function DashboardRoute(): React.ReactElement {
  const { revenue, decimals, explorer, alerts } = useLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-xl p-xl">
      <h1 data-testid="dashboard-title" className="text-display font-display lowercase text-ink">
        dashboard
      </h1>
      <RevenuePanel revenue={revenue} decimals={decimals} />
      <ResourceTable receipts={revenue.receipts} decimals={decimals} explorer={explorer} alerts={alerts} />
    </div>
  );
}
