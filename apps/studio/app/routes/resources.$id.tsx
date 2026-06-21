// resources.$id.tsx - the STU-03 resource-detail loader + screen (D-STU-03).
//
// Read-through discipline (T-06-REDERIVE), mirroring apps/marketplace/src/
// card-route.ts: the loader validates params.id (isSafeParam), then calls
// selectAdapter(process.env).getResourceDetail(params.id) - which PROJECTS
// card + health + bond + sandbox from the existing services through the adapter -
// and returns it. It NEVER recomputes a price or mints an identity (the Phase-5
// mandate the card route enforces); the rendered price is the projected base units,
// not a recomputation.
//
// The runtime money decimals come from a read through the adapter (no 6/1e6
// literal); money renders only through the single UsdcAmount surface.
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import type { ResourceDetail } from "../adapter/types.js";
import { UsdcAmount } from "../components/primitives/UsdcAmount.js";
import { PricePill } from "../components/primitives/PricePill.js";
import { AddressPill } from "../components/primitives/AddressPill.js";
import { BondBadge } from "../components/primitives/BondBadge.js";
import { StatusDot, type StatusState } from "../components/primitives/StatusDot.js";
import { ReputationBadge } from "../components/primitives/ReputationBadge.js";
import { ResourceTabs } from "../components/detail/ResourceTabs.js";
import { CardPreview } from "../components/detail/CardPreview.js";
import { OpenApiPreview } from "../components/detail/OpenApiPreview.js";

/** A bounded, safe resourceId param (decode-before-use, ASVS V5 - card-route.ts). */
function isSafeParam(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/** The serialized loader payload: the read-through detail + the runtime decimals. */
export interface ResourceDetailData {
  detail: ResourceDetail;
  decimals: number;
}

export async function loader({ params }: LoaderFunctionArgs): Promise<ResourceDetailData> {
  // T-06-PARAM: validate before the adapter so a crafted id cannot reach the source.
  if (!isSafeParam(params.id)) {
    throw new Response(JSON.stringify({ error: "bad_resource" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const adapter = selectAdapter(process.env);

  let detail: ResourceDetail;
  try {
    // Read-through projection (card+health+bond+sandbox). Never re-derived here.
    detail = await adapter.getResourceDetail(params.id);
  } catch {
    // An unknown resource surfaces a not-found path (the read-through source said no).
    throw new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Runtime money scale read through the adapter (no 6/1e6 literal in the render).
  const { decimals } = await adapter.getEscrowBalance(detail.payout);
  return { detail, decimals };
}

/** Map the projected sandbox status to the StatusDot state (shape + color motif). */
function sandboxToState(sandbox: ResourceDetail["sandbox"]): StatusState {
  switch (sandbox) {
    case "live":
      return "live";
    case "deploying":
      return "building";
    case "degraded":
      return "paused";
    case "down":
      return "failed";
    default:
      return "idle";
  }
}

export default function ResourceDetailRoute(): React.ReactElement {
  const { detail, decimals } = useLoaderData<typeof loader>();
  const base = BigInt(detail.pricing.base);
  const cap = BigInt(detail.pricing.max);
  const isMetered = detail.pricing.model === "metered";

  const overview = (
    <div data-testid="detail-overview" className="flex flex-col gap-md">
      <div className="flex flex-wrap items-center gap-md">
        {/* sandbox status: shape + color (StatusDot) */}
        <StatusDot state={sandboxToState(detail.sandbox)} />
        {/* health: verified circle + rolling score */}
        <span data-testid="detail-health" className="font-mono text-caption-mono text-ink-muted">
          {detail.health.verified ? "verified" : "unverified"}
          {detail.health.score !== null ? ` · ${detail.health.score}` : ""}
        </span>
        {/* agentId: blue identity badge */}
        <span
          data-testid="detail-agent-id"
          className="inline-flex items-center gap-2xs border border-blue px-xs py-2xs font-mono text-caption-mono text-blue"
        >
          {`agent #${detail.agentId}`}
        </span>
        <BondBadge bond={detail.bond} decimals={decimals} />
      </div>
      <div className="flex flex-wrap items-center gap-md">
        <span className="text-label font-display text-ink-muted lowercase">payout</span>
        <AddressPill address={detail.payout} />
      </div>
    </div>
  );

  const api = <OpenApiPreview openapi={{ openapi: "3.1.0", info: { title: detail.slug } }} />;
  const card = (
    <CardPreview
      cardUrl={detail.cardUrl}
      card={{
        protocolVersion: "0.3.0",
        name: detail.slug,
        agentId: detail.agentId,
        category: detail.category,
      }}
    />
  );
  const reputation = (
    <div data-testid="detail-reputation" className="flex items-center gap-md">
      <ReputationBadge feedbackCount={0n} />
      <span className="font-mono text-caption-mono text-ink-muted">
        {detail.health.verified ? "verified endpoint" : "not yet verified"}
      </span>
    </div>
  );
  const pricing = (
    <div data-testid="detail-pricing" className="flex flex-col gap-xs">
      <PricePill
        baseUnits={base}
        decimals={decimals}
        model={isMetered ? "metered" : "flat"}
        capBaseUnits={isMetered ? cap : undefined}
      />
      <div className="font-mono text-caption-mono text-ink-muted">
        {"cap "}
        <UsdcAmount baseUnits={cap} decimals={decimals} />
      </div>
    </div>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-lg p-xl">
      {/* ResourceMeta: title + price */}
      <div className="flex flex-wrap items-center justify-between gap-md">
        <h1 data-testid="detail-title" className="text-display font-display lowercase text-ink">
          {detail.slug}
        </h1>
        <PricePill
          baseUnits={base}
          decimals={decimals}
          model={isMetered ? "metered" : "flat"}
          capBaseUnits={isMetered ? cap : undefined}
        />
      </div>

      <ResourceTabs content={{ overview, api, card, reputation, pricing }} />
    </div>
  );
}
