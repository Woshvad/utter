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
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import type { AcceptsEntry } from "@utter/x402-arc";
import { selectAdapter } from "../adapter/select.js";
import type { PlaygroundResult, ResourceDetail } from "../adapter/types.js";
import { usePayPerCall } from "../wallet/usePayPerCall.js";
import { selectSubmitPayment } from "../wallet/submit-payment.js";
import { PlaygroundPlayer } from "../components/playground/PlaygroundPlayer.js";
import { extractRequestSchema } from "../components/playground/openapi-fields.js";
import { UsdcAmount } from "../components/primitives/UsdcAmount.js";
import { PricePill } from "../components/primitives/PricePill.js";
import { AddressPill } from "../components/primitives/AddressPill.js";
import { BondBadge } from "../components/primitives/BondBadge.js";
import { StatusDot, type StatusState } from "../components/primitives/StatusDot.js";
import { VerifiedBadge } from "../components/primitives/VerifiedBadge.js";
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
  /**
   * The client pay-submission mode (260622-wlu). "live" selects the operator-gated
   * fail-loud submitter; anything else (the autonomous default) routes the signed cap
   * back through this route's action (the in-process facilitator). Derived server-side
   * from STUDIO_DATA_ADAPTER so the browser inherits the same fixture/live boundary.
   */
  payMode: string;
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
  // The client pay-submission mode inherits the same fixture/live boundary the adapter
  // uses (selectAdapter): live -> the fail-loud live submitter; anything else -> the
  // deterministic fixture path through this action.
  const payMode = process.env.STUDIO_DATA_ADAPTER === "live" ? "live" : "fixture";
  return { detail, decimals, payMode };
}

/**
 * The playground Run seam (STU-03): the client onRun POSTs the request body here and
 * the action drives adapter.runPlayground, which reuses the FROZEN escrow gate
 * (reserve-before-run, T-06-FREECOMPUTE). The component NEVER calls a handler against
 * an unreserved authorization - the only run path is through this adapter seam. The
 * bigint debitAmount is serialized as a string for the JSON wire.
 */
export async function action({ params, request }: ActionFunctionArgs) {
  if (!isSafeParam(params.id)) {
    throw new Response(JSON.stringify({ error: "bad_resource" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const adapter = selectAdapter(process.env);
  let req: unknown = null;
  try {
    const text = await request.text();
    req = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    req = null;
  }
  const result = await adapter.runPlayground(params.id, req);
  // Serialize the bigint debit for the wire; the client re-reads it as a string.
  return {
    paid: result.paid,
    debitAmount: result.debitAmount.toString(),
    body: result.body,
    bodyBytes: result.bodyBytes,
    handlerMs: result.handlerMs,
    paywall: result.paywall,
  };
}

/**
 * Derive the resource origin from the projected cardUrl by stripping the
 * /.well-known/agent-card.json suffix. The cardUrl is the only URL the detail
 * projection exposes; the resource URL is read from it, never invented.
 */
function resourceUrlFromCard(cardUrl: string): string {
  return cardUrl.replace(/\/\.well-known\/agent-card\.json$/, "");
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
  const { detail, decimals, payMode } = useLoaderData<typeof loader>();
  const base = BigInt(detail.pricing.base);
  const cap = BigInt(detail.pricing.max);
  const isMetered = detail.pricing.model === "metered";

  // The `api` tab renders an honest OpenAPI-shaped descriptor assembled ONLY from
  // projected detail fields. It carries no invented paths/methods/body schema (the
  // adapter does not expose them), so it documents the resource truthfully from what
  // exists. The same value feeds extractRequestSchema; a path-less doc yields empty
  // fields -> the playground raw-JSON fallback, preserving the current behavior.
  // The pricing figures are the raw base-unit strings off the projection (NOT
  // formatted money) so this descriptor introduces no money-scale literal.
  const openapiDoc = {
    openapi: "3.1.0",
    info: {
      title: detail.slug,
      "x-category": detail.category,
    },
    "x-utter": {
      agentId: detail.agentId,
      category: detail.category,
      resourceUrl: resourceUrlFromCard(detail.cardUrl),
      cardUrl: detail.cardUrl,
      pricing: {
        model: detail.pricing.model,
        base: detail.pricing.base,
        perKB: detail.pricing.perKB,
        max: detail.pricing.max,
      },
    },
  };
  const requestSchema = extractRequestSchema(openapiDoc);

  // The Run seam: POST the body to this route's action, which drives
  // adapter.runPlayground (reserve-before-run inside the adapter). The component never
  // calls a handler directly. The action serializes debitAmount as a string; re-read
  // it as a bigint here so the metered render path stays base-unit bigint.
  const onRun = React.useCallback(
    async (req: unknown): Promise<PlaygroundResult> => {
      const res = await fetch(`/resources/${detail.resourceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req ?? null),
      });
      const data = (await res.json()) as Omit<PlaygroundResult, "debitAmount"> & {
        debitAmount: string;
      };
      return { ...data, debitAmount: BigInt(data.debitAmount) };
    },
    [detail.resourceId],
  );

  // The client-side wallet pay seam (260622-wlu). The signed X-PAYMENT submission routes
  // through the selected submitter (fixture -> this route's action; live -> fail-loud).
  // The submitter result IS a PlaygroundResult; usePayPerCall returns it under `result`.
  const submitPayment = React.useMemo(
    () => selectSubmitPayment({ resourceId: detail.resourceId, mode: payMode }),
    [detail.resourceId, payMode],
  );
  const { pay } = usePayPerCall({ decimals, submitPayment });

  // onPayWithWallet: the connected wallet signs the escrow CAP for the 402 quote (popup,
  // no key in the app) and submits it; the browser only signs + submits the cap, the
  // facilitator keeps reserve-before-run + the gate + settle server-side. The pay result
  // is the submitter's PlaygroundResult (streamed by the player into the done phase).
  const onPayWithWallet = React.useCallback(
    async (quote: AcceptsEntry): Promise<PlaygroundResult> => {
      const { result } = await pay(quote);
      return result as PlaygroundResult;
    },
    [pay],
  );

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
        <span className="text-label font-display text-ink-muted lowercase">category</span>
        <span
          data-testid="detail-category"
          className="font-mono text-caption-mono text-ink lowercase"
        >
          {detail.category}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-md">
        <span className="text-label font-display text-ink-muted lowercase">payout</span>
        <AddressPill address={detail.payout} />
      </div>
    </div>
  );

  const api = <OpenApiPreview openapi={openapiDoc} caption="openapi.json" />;
  const playground = (
    <PlaygroundPlayer
      resourceId={detail.resourceId}
      decimals={decimals}
      pricing={{
        model: "metered",
        base: detail.pricing.base,
        perKB: detail.pricing.perKB,
        computeMultiplier: "0",
        maxResponseBytes: 1_048_576,
      }}
      cap={cap}
      onRun={onRun}
      onPayWithWallet={onPayWithWallet}
      requestSchema={requestSchema}
    />
  );
  // A canonical A2A agent-card assembled by read-through from real detail fields.
  // The pricing/x402 block carries the raw base-unit pricing strings + the payout
  // address; no on-chain value is minted or invented here. The pricing strings are
  // the projection's own base-unit values, not formatted money (no scale literal).
  const card = (
    <CardPreview
      cardUrl={detail.cardUrl}
      card={{
        protocolVersion: "0.3.0",
        name: detail.slug,
        agentId: detail.agentId,
        category: detail.category,
        url: resourceUrlFromCard(detail.cardUrl),
        pricing: {
          scheme: "x402",
          model: detail.pricing.model,
          base: detail.pricing.base,
          perKB: detail.pricing.perKB,
          max: detail.pricing.max,
          payTo: detail.payout,
        },
      }}
    />
  );
  // The Reputation tab renders ONLY the trust signals the detail projection actually
  // exposes: health.verified, the rolling health.score, and the posted bond. There is
  // no reputation/feedbackCount field on ResourceDetail, so a count of 0 would be
  // fabricated; ERC-8004 feedback is surfaced on the marketplace card, not here.
  const reputation = (
    <div data-testid="detail-reputation" className="flex flex-col gap-md">
      <div className="flex flex-wrap items-center gap-md">
        <VerifiedBadge verified={detail.health.verified} />
        <span data-testid="detail-rep-score" className="font-mono text-caption-mono text-ink-muted">
          {detail.health.score !== null ? `score ${detail.health.score}` : "unscored"}
        </span>
        <BondBadge bond={detail.bond} decimals={decimals} />
      </div>
      <span className="font-mono text-caption-mono text-ink-faint">
        ERC-8004 feedback is surfaced on the marketplace card, not on this projection.
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
      {isMetered ? (
        <div data-testid="detail-perkb" className="font-mono text-caption-mono text-ink-muted">
          {"per kb "}
          <UsdcAmount baseUnits={BigInt(detail.pricing.perKB)} decimals={decimals} />
        </div>
      ) : null}
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

      <ResourceTabs content={{ overview, playground, api, card, reputation, pricing }} />
    </div>
  );
}
