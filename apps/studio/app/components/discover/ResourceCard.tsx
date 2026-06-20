// ResourceCard - THE marketplace card (the most important component). A hard-edged
// block per the UI-SPEC "Marketplace / Discover": a geometric spec-preview tile
// (schema-derived, NOT a photo), the lowercase title, a creator chip, the mono
// PricePill, and the reputation / bond / verified badges.
//
// Read-through mandate (T-06-REDERIVE): this component RENDERS the Phase-5 card
// projection. It never recomputes a price or identity - `pricing.base` / `.max` are
// passed straight to UsdcAmount/PricePill as base units.
import * as React from "react";
import type { ResourceCardData } from "../../adapter/types";
import { PricePill } from "../primitives/PricePill";
import { ReputationBadge } from "../primitives/ReputationBadge";
import { BondBadge } from "../primitives/BondBadge";
import { VerifiedBadge } from "../primitives/VerifiedBadge";

export interface ResourceCardProps {
  card: ResourceCardData;
  /** Decimals from a runtime read (passed straight through to the money renders). */
  decimals: number;
  /** Verified status projected from the scorer (kept distinct from uptime). */
  verified?: boolean;
  /** Optional creator display name; falls back to the agentId chip. */
  creatorName?: string;
  href?: string;
}

/**
 * A deterministic geometric preview tile derived from the resourceId - the triad
 * shapes (circle/square/triangle) arranged by a hash of the id. Schema-derived art,
 * never a photo (brief anti-pattern: no stock photography).
 */
function SpecPreviewTile({ seed }: { seed: string }): React.ReactElement {
  // cheap deterministic hash -> three placements
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = h % 3;
  const b = (h >> 3) % 3;
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-full w-full"
      role="img"
      aria-label="spec preview"
      data-testid="spec-preview"
    >
      <rect width="100" height="100" fill="var(--canvas)" />
      <circle cx={28 + a * 8} cy="40" r="11" fill="var(--red)" />
      <rect x={52 + b * 6} y="32" width="16" height="16" fill="var(--blue)" />
      <polygon points="40,58 50,72 30,72" fill="var(--yellow)" />
    </svg>
  );
}

export function ResourceCard({
  card,
  decimals,
  verified,
  creatorName,
  href,
}: ResourceCardProps): React.ReactElement {
  const model = card.pricing.model === "metered" ? "metered" : "flat";
  const baseUnits = BigInt(card.pricing.base);
  const capUnits = BigInt(card.pricing.max);
  const uptimePct = Math.round(card.uptime * 100);

  const body = (
    <article
      data-testid="resource-card"
      className="group flex flex-col border border-hairline bg-raised transition-transform duration-150 hover:-translate-y-0.5"
    >
      {/* geometric spec-preview tile */}
      <div className="aspect-[16/9] w-full border-b border-hairline">
        <SpecPreviewTile seed={card.resourceId} />
      </div>

      <div className="flex flex-col gap-sm p-md">
        {/* lowercase title */}
        <h3 className="text-heading font-display font-semibold tracking-tight text-ink lowercase">
          {card.slug}
        </h3>

        {/* creator chip: circle avatar + name + reputation */}
        <div className="flex items-center gap-xs text-caption-mono font-mono text-ink-muted">
          <span
            aria-hidden="true"
            className="inline-block rounded-full border border-hairline bg-canvas"
            style={{ width: 16, height: 16 }}
          />
          <span className="lowercase">{creatorName ?? `agent ${card.agentId}`}</span>
          <ReputationBadge feedbackCount={card.reputation} />
        </div>

        {/* mono price pill */}
        <PricePill
          baseUnits={baseUnits}
          decimals={decimals}
          model={model}
          capBaseUnits={model === "metered" ? capUnits : undefined}
        />

        {/* badges row + stats */}
        <div className="flex flex-wrap items-center gap-xs">
          <VerifiedBadge verified={Boolean(verified)} />
          <BondBadge bond={card.bond} decimals={decimals} />
          <span className="font-mono text-caption-mono text-ink-faint tabular-nums lowercase">
            {uptimePct}% uptime
          </span>
        </div>
      </div>
    </article>
  );

  return href ? (
    <a href={href} className="block outline-none focus-visible:ring-2 focus-visible:ring-blue">
      {body}
    </a>
  ) : (
    body
  );
}
