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
// literal); money renders only through the single UsdcAmount surface. The related
// rail items carry a pre-formatted priceLabel string (built in the loader via the
// SAME bigint divmod UsdcAmount uses, off the runtime decimals) so no bigint crosses
// the JSON wire while the projected price stays exact (never recomputed).
import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import type { AcceptsEntry } from "@utter/x402-arc";
import { selectAdapter } from "../adapter/select.js";
import { tryGetRevenue } from "../adapter/revenue.js";
import type { PlaygroundResult, ResourceDetail } from "../adapter/types.js";
import { usePayPerCall } from "../wallet/usePayPerCall.js";
import { selectSubmitPayment } from "../wallet/submit-payment.js";
import { PlaygroundPlayer } from "../components/playground/PlaygroundPlayer.js";
import { extractRequestSchema } from "../components/playground/openapi-fields.js";
import { UsdcAmount } from "../components/primitives/UsdcAmount.js";
import { PricePill } from "../components/primitives/PricePill.js";
import { BondBadge } from "../components/primitives/BondBadge.js";
import { VerifiedBadge } from "../components/primitives/VerifiedBadge.js";
import { ResourceTabs } from "../components/detail/ResourceTabs.js";
import { CardPreview } from "../components/detail/CardPreview.js";
import { OpenApiPreview } from "../components/detail/OpenApiPreview.js";
import { McpConnectBlock } from "../components/detail/McpConnectBlock.js";

/** A bounded, safe resourceId param (decode-before-use, ASVS V5 - card-route.ts). */
function isSafeParam(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/** One projected "related" rail item - no bigint crosses the wire (priceLabel is a
 *  pre-formatted string built from the projected base units + runtime decimals). */
export interface RelatedItem {
  resourceId: string;
  slug: string;
  /** A "$x.xxxx" / "$x.xxxx metered" string built in the loader (never recomputed). */
  priceLabel: string;
  /** A human creator label projected from the card's agentId. */
  creatorLabel: string;
}

/** The serialized loader payload: the read-through detail + the runtime decimals. */
export interface ResourceDetailData {
  detail: ResourceDetail;
  decimals: number;
  /** Real settled-calls count sourced from the adapter getRevenue (the legitimate data
   *  path; fixture-backed by default). The title-block calls stat renders from this,
   *  never from a hash. Null means the revenue read failed (a transient/unreachable
   *  facilitator in live mode); the title-block renders a dash, never a fabricated zero. */
  calls: number | null;
  /**
   * The client pay-submission mode (260622-wlu). "live" selects the operator-gated
   * fail-loud submitter; anything else (the autonomous default) routes the signed cap
   * back through this route's action (the in-process facilitator). Derived server-side
   * from STUDIO_DATA_ADAPTER so the browser inherits the same fixture/live boundary.
   */
  payMode: string;
  /** Up to four sibling cards for the right-rail RELATED list (read-through). */
  related: RelatedItem[];
}

/**
 * Format a projected base-unit price STRING to a "$x.xxxx" display string using the
 * SAME bigint divmod UsdcAmount applies (decimals from the runtime read, NO 6/1e6
 * literal). The price is never recomputed - the string is the projected base units
 * scaled by the runtime decimals only, so the rail figure stays exact.
 */
function formatPriceLabel(baseUnitsStr: string, decimals: number, metered: boolean): string {
  const baseUnits = BigInt(baseUnitsStr || "0");
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const frac = (baseUnits % divisor).toString().padStart(decimals, "0");
  const dollars = decimals === 0 ? `$${whole}` : `$${whole}.${frac}`;
  return metered ? `${dollars} metered` : dollars;
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
  // Decimals come from the zero-address probe, NOT detail.payout. detail.payout is a
  // bytes32 resourceId (66-char keccak), not a 20-byte address, so passing it to the
  // escrow balance read throws via viem isAddress(); the zero address is the same safe
  // decimals probe the other loaders use. detail.payout stays the escrow/payTo target
  // everywhere else (the card and wallet-sign paths keep it).
  const { decimals } = await adapter.getEscrowBalance(
    "0x0000000000000000000000000000000000000000",
  );
  // Real settled-calls count sourced THROUGH the display-only tryGetRevenue wrapper. A
  // failed (live-mode) facilitator read yields null here, so the title-block renders a
  // dash rather than crashing or fabricating a zero.
  const revenue = await tryGetRevenue(adapter, detail.resourceId);
  const calls = revenue ? revenue.calls : null;
  // The client pay-submission mode inherits the same fixture/live boundary the adapter
  // uses (selectAdapter): live -> the fail-loud live submitter; anything else -> the
  // deterministic fixture path through this action.
  const payMode = process.env.STUDIO_DATA_ADAPTER === "live" ? "live" : "fixture";

  // The RELATED rail: read sibling cards THROUGH the same listMarketplace seam, drop
  // the current resource, and project at most four into a wire-safe shape (priceLabel
  // pre-formatted from the projected base units; no bigint crosses the wire).
  let related: RelatedItem[] = [];
  try {
    const cards = await adapter.listMarketplace({});
    related = cards
      .filter((c) => c.resourceId !== detail.resourceId)
      .slice(0, 4)
      .map((c) => ({
        resourceId: c.resourceId,
        slug: c.slug,
        priceLabel: formatPriceLabel(c.pricing.base, decimals, c.pricing.model === "metered"),
        creatorLabel: `agent ${c.agentId}`,
      }));
  } catch {
    related = [];
  }

  return { detail, decimals, calls, payMode, related };
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
  let result: PlaygroundResult;
  try {
    result = await adapter.runPlayground(params.id, req);
  } catch (err) {
    // Error path: a rejected hosted run (a live deployer/sandbox failure) returns an
    // error-shaped 200 JSON the client can render, rather than a non-Response throw that
    // becomes a 500 the client fetch cannot parse and that hangs the response pane. The
    // debitAmount is the wire string "0" (this route serializes the debit as a string).
    // console.error logs the failure server-side only; a playground run error carries no
    // secret. The escrow gate is untouched: this is purely the rejection branch.
    console.error("playground run failed", err);
    return {
      paid: false,
      debitAmount: "0",
      body: { error: err instanceof Error ? err.message : "playground run failed" },
      bodyBytes: 0,
      handlerMs: 0,
      paywall: null,
    };
  }
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

/** A short, stable creator handle from the owner address (truncated 0x form). */
function creatorHandle(creator: string): string {
  return creator.length > 10 ? `${creator.slice(0, 6)}…${creator.slice(-4)}` : creator;
}

export default function ResourceDetailRoute(): React.ReactElement {
  const { detail, decimals, calls, payMode, related } = useLoaderData<typeof loader>();
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

  // The resource origin derived from the projected cardUrl (the only URL the projection
  // exposes). The live transport POSTs the signed X-PAYMENT here; in fixture mode this is
  // ignored. Memoized so the submitter memo below stays stable.
  const resourceUrl = React.useMemo(
    () => resourceUrlFromCard(detail.cardUrl),
    [detail.cardUrl],
  );

  // The LAST playground request body, captured in a ref (260623-deq). The PAID call must
  // reuse the SAME body that triggered the 402, so the live transport reads it at call time
  // via getRequestBody. A ref (not state) so the submitter memo does not churn per keystroke
  // and exactly-once/retry semantics stay intact.
  const lastReqRef = React.useRef<unknown>(null);
  const getRequestBody = React.useCallback(() => lastReqRef.current, []);

  // The Run seam: POST the body to this route's action, which drives
  // adapter.runPlayground (reserve-before-run inside the adapter). The component never
  // calls a handler directly. The action serializes debitAmount as a string; re-read
  // it as a bigint here so the metered render path stays base-unit bigint.
  const onRun = React.useCallback(
    async (req: unknown): Promise<PlaygroundResult> => {
      // Capture the body so a subsequent wallet pay submits the SAME body that hit the 402.
      lastReqRef.current = req;
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

  // The client-side wallet pay seam (260622-wlu, 260623-deq). The signed X-PAYMENT
  // submission routes through the selected submitter (fixture -> this route's action; live
  // -> the real x402 transport when a resourceUrl is configured, else fail-loud). The
  // submitter result IS a PlaygroundResult; usePayPerCall returns it under `result`. The
  // request body is read via the ref at call time so the memo stays stable.
  const submitPayment = React.useMemo(
    () =>
      selectSubmitPayment({
        resourceId: detail.resourceId,
        mode: payMode,
        resourceUrl,
        getRequestBody,
      }),
    [detail.resourceId, payMode, resourceUrl, getRequestBody],
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

  // The overview tab: the comp's description paragraph + a badges row. The description
  // is assembled honestly from the slug + category (no invented capability claims); the
  // badges read straight off the projection (category / verified / posted bond).
  const description =
    `${detail.slug} is a ${detail.category} endpoint listed on utter. ` +
    `it runs in an isolated sandbox, carries an on-chain erc-8004 identity, and ai ` +
    `agents pay per call in usdc on arc - debited only after the response passes the ` +
    `escrow gate.`;
  const repScore = detail.health.score !== null ? Math.round(detail.health.score * 100) : null;

  const overview = (
    <div data-testid="detail-overview" className="flex flex-col">
      <p
        data-testid="detail-description"
        className="my-[22px] max-w-[640px] text-[15px] leading-[1.6] text-ink-muted lowercase"
      >
        {description}
      </p>
      <div className="flex flex-wrap gap-[10px]">
        <span
          data-testid="detail-category"
          className="border border-hairline px-[12px] py-[6px] font-mono text-[12px] text-ink-muted lowercase"
        >
          {detail.category}
        </span>
        {detail.health.verified ? (
          <span className="flex items-center gap-[6px] border border-hairline px-[12px] py-[6px] font-mono text-[12px] text-ink-muted lowercase">
            <span aria-hidden="true" className="h-[8px] w-[8px] rounded-full bg-blue" />
            verified
          </span>
        ) : null}
        <span className="flex items-center gap-[6px] border border-hairline px-[12px] py-[6px] font-mono text-[12px] text-yellow lowercase">
          <span aria-hidden="true" className="h-[8px] w-[8px] bg-yellow" />
          <UsdcAmount baseUnits={detail.bond} decimals={decimals} />
          {" bond"}
        </span>
      </div>
    </div>
  );

  const api = <OpenApiPreview openapi={openapiDoc} caption="openapi.json" />;
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

  // Stats for the comp's title-block row. Both figures are REAL: calls is the
  // adapter-sourced settled-calls count (getRevenue), uptime is the rolling health
  // score. The old hash-fabricated p50 latency is dropped (no real telemetry source).
  const uptimeLabel = repScore !== null ? `${(detail.health.score! * 100).toFixed(2)}%` : "—";
  // A null calls (the revenue read failed) renders a dash, never a fabricated zero. The
  // compact branches apply only when a real count is present.
  const callsLabel =
    calls === null
      ? "-"
      : calls >= 1_000_000
        ? `${(calls / 1_000_000).toFixed(2)}M`
        : calls >= 1_000
          ? `${(calls / 1_000).toFixed(1)}K`
          : `${calls}`;

  return (
    <div className="flex max-w-[1320px]" data-testid="resource-detail">
      {/* left content column */}
      <div className="min-w-0 flex-1 px-[32px] pb-[64px] pt-[24px]">
        {/* back link */}
        <Link
          to="/discover"
          data-testid="detail-back"
          className="mb-[16px] block font-mono text-[12px] text-ink-faint lowercase"
        >
          ← discover
        </Link>

        {/* PLAYER - the always-visible framed hero */}
        <PlaygroundPlayer
          resourceId={detail.resourceId}
          decimals={decimals}
          resourceUrl={resourceUrlFromCard(detail.cardUrl)}
          method={requestSchema.methods[0] ?? "POST"}
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

        {/* title block: h1 + creator chip + 3-up stats */}
        <div className="flex items-start gap-[16px] border-b border-hairline py-[24px]">
          <div className="flex-1">
            <h1
              data-testid="detail-title"
              className="mb-[12px] text-[26px] font-semibold tracking-[-0.02em] text-ink lowercase"
            >
              {detail.slug}
            </h1>
            <div className="flex items-center gap-[10px]">
              <Link
                to={`/creators/${detail.creator}`}
                data-testid="detail-creator"
                className="flex items-center gap-[8px]"
              >
                <span aria-hidden="true" className="h-[30px] w-[30px] rounded-full bg-blue" />
                <span className="block">
                  <span className="block text-[14px] font-medium text-ink">
                    {creatorHandle(detail.creator)}
                  </span>
                  <span className="block font-mono text-[11px] text-ink-faint">
                    {repScore !== null ? `reputation ${repScore}/100` : "reputation —"}
                  </span>
                </span>
              </Link>
              <Link
                to={`/creators/${detail.creator}`}
                className="ml-[8px] border border-hairline px-[16px] py-[8px] font-mono text-[13px] text-ink lowercase"
              >
                + follow
              </Link>
            </div>
          </div>
          {/* a seamless 1px-hairline stats grid - calls + uptime, both real. The
              comp's p50 cell is dropped (no real latency telemetry to source it). */}
          <div
            data-testid="detail-stats"
            className="flex gap-px border border-hairline bg-hairline"
          >
            <div className="bg-raised px-[18px] py-[12px] text-center">
              <div className="font-mono text-[16px] font-bold text-ink">{callsLabel}</div>
              <div className="font-mono text-[10px] text-ink-faint">calls</div>
            </div>
            <div className="bg-raised px-[18px] py-[12px] text-center">
              <div className="font-mono text-[16px] font-bold text-ink">{uptimeLabel}</div>
              <div className="font-mono text-[10px] text-ink-faint">uptime</div>
            </div>
          </div>
        </div>

        {/* tabs (no playground tab; the player is the hero) */}
        <div className="mt-[4px]">
          <ResourceTabs content={{ overview, api, card, reputation, pricing }} />
        </div>
      </div>

      {/* right rail: mcp connect + related */}
      <aside className="w-[340px] flex-none border-l border-hairline bg-canvas p-[24px]">
        <div className="mb-[24px]">
          <McpConnectBlock resourceId={detail.resourceId} cardUrl={detail.cardUrl} />
        </div>
        <div className="mb-[14px] font-mono text-[11px] tracking-[0.06em] text-ink-faint">
          RELATED
        </div>
        <div data-testid="detail-related" className="flex flex-col gap-[12px]">
          {related.map((r) => (
            <Link
              key={r.resourceId}
              to={`/resources/${r.resourceId}`}
              className="flex cursor-pointer gap-[12px]"
            >
              <div className="relative h-[56px] w-[88px] flex-none overflow-hidden border border-hairline bg-canvas">
                <span
                  aria-hidden="true"
                  className="absolute left-[14px] top-[11px] h-[30px] w-[30px] bg-blue"
                />
                <span
                  aria-hidden="true"
                  className="absolute right-[16px] top-[14px] h-[24px] w-[24px] rounded-full border-2 border-ink"
                />
              </div>
              <div className="min-w-0">
                <div className="mb-[4px] truncate text-[13px] font-medium text-ink lowercase">
                  {r.slug}
                </div>
                <div className="font-mono text-[11px] text-ink-muted">{r.creatorLabel}</div>
                <div className="font-mono text-[11px] text-yellow">{r.priceLabel}</div>
              </div>
            </Link>
          ))}
        </div>
      </aside>
    </div>
  );
}
