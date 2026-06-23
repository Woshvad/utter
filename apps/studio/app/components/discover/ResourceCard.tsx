// ResourceCard - THE marketplace card (the most important component). A hard-edged
// block per the comp (Utter.dc.html 397-433): a geometric accent-motif thumbnail with
// an in-thumbnail verified badge, the lowercase title, a creator row (colored avatar +
// name + "/100" reputation), a yellow PricePill, and a calls figure.
//
// Reused by landing (thumbHeight 120) and profile (130); the thumbHeight + motif props
// let those screens reuse the same card at a different tile height/variant.
//
// Read-through mandate (T-06-REDERIVE): this component RENDERS the Phase-5 card
// projection. It never recomputes a price or identity - `pricing.base` / `.max` are
// passed straight to UsdcAmount/PricePill as base units. The accent/motif/creator
// color are deterministic presentation derived from the id - they are not money. The
// calls figure is an OPTIONAL prop sourced from the adapter getRevenue; when it is
// absent the figure is omitted (never fabricated from a hash).
import * as React from "react";
import type { ResourceCardData } from "../../adapter/types";
import { PricePill } from "../primitives/PricePill";
import { ReputationBadge } from "../primitives/ReputationBadge";

export interface ResourceCardProps {
  card: ResourceCardData;
  /** Decimals from a runtime read (passed straight through to the money renders). */
  decimals: number;
  /** Verified status projected from the scorer (kept distinct from uptime). */
  verified?: boolean;
  /** Optional creator display name; falls back to the agentId chip. */
  creatorName?: string;
  /** Thumbnail height in px (default 150; landing uses 120, profile 130). */
  thumbHeight?: number;
  /** Force a motif variant (0|1|2); defaults to a deterministic pick from the id. */
  motif?: 0 | 1 | 2;
  /** Real settled-calls figure sourced from the adapter getRevenue. When omitted the
   *  card renders no calls figure (never a fabricated stand-in). */
  calls?: number;
  href?: string;
  /** Landing-strip compact form (comp 148-158): title (14px) + yellow price ONLY -
   *  hides the creator row, the calls figure, and the verified badge. Default false
   *  keeps the full discover card unchanged. */
  compact?: boolean;
}

/** Cheap deterministic hash of a seed string (FNV-ish). */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

const TRIAD = ["var(--red)", "var(--blue)", "var(--yellow)"] as const;

/**
 * The accent geometry tile - one of three motif variants driven by a per-card accent
 * color, mirroring the comp's m0/m1/m2 thumbnails (Utter.dc.html 399-413). Shapes only;
 * no money or identity is derived here.
 */
function MotifTile({ motif, accent }: { motif: 0 | 1 | 2; accent: string }): React.ReactElement {
  if (motif === 0) {
    return (
      <>
        <div className="absolute" style={{ left: 30, top: 28, width: 70, height: 70, background: accent }} />
        <div
          className="absolute rounded-full"
          style={{ right: 36, top: 34, width: 62, height: 62, border: "3px solid var(--ink)" }}
        />
        <div
          className="absolute"
          style={{
            right: 44,
            bottom: 24,
            width: 0,
            height: 0,
            borderTop: "11px solid transparent",
            borderBottom: "11px solid transparent",
            borderLeft: `18px solid ${accent}`,
          }}
        />
      </>
    );
  }
  if (motif === 1) {
    return (
      <>
        <div
          className="absolute"
          style={{
            left: 34,
            top: 30,
            width: 0,
            height: 0,
            borderLeft: "36px solid transparent",
            borderRight: "36px solid transparent",
            borderBottom: `64px solid ${accent}`,
          }}
        />
        <div
          className="absolute rounded-full"
          style={{ right: 40, top: 44, width: 56, height: 56, background: "var(--ink)" }}
        />
        <div
          className="absolute"
          style={{ left: 120, bottom: 22, width: 44, height: 44, border: `3px solid ${accent}` }}
        />
      </>
    );
  }
  return (
    <>
      <div
        className="absolute rounded-full"
        style={{ left: 28, top: 26, width: 66, height: 66, background: accent }}
      />
      <div
        className="absolute"
        style={{ right: 34, top: 30, width: 58, height: 58, border: "3px solid var(--ink)" }}
      />
      <div
        className="absolute"
        style={{
          right: 40,
          bottom: 22,
          width: 0,
          height: 0,
          borderLeft: "9px solid transparent",
          borderRight: "9px solid transparent",
          borderBottom: `16px solid ${accent}`,
        }}
      />
    </>
  );
}

export function ResourceCard({
  card,
  decimals,
  verified,
  creatorName,
  thumbHeight = 150,
  motif,
  calls,
  href,
  compact = false,
}: ResourceCardProps): React.ReactElement {
  const model = card.pricing.model === "metered" ? "metered" : "flat";
  const baseUnits = BigInt(card.pricing.base);
  const capUnits = BigInt(card.pricing.max);

  // Deterministic presentation derived from the id (NOT money / NOT reputation):
  const h = hashSeed(card.resourceId);
  const resolvedMotif: 0 | 1 | 2 = motif ?? ((h % 3) as 0 | 1 | 2);
  const accent = TRIAD[h % 3]!;
  const creatorColor = TRIAD[(h >> 3) % 3]!;
  // The calls figure is rendered ONLY when a real adapter-sourced count is passed; an
  // absent count omits the figure rather than inventing one.
  const callsFmt = calls != null ? `${calls.toLocaleString("en-US")} calls` : null;

  const body = (
    <article
      data-testid="resource-card"
      className="group flex cursor-pointer flex-col border border-hairline bg-raised transition-transform duration-150 hover:-translate-y-0.5"
    >
      {/* accent-motif thumbnail with the in-thumbnail verified badge */}
      <div
        className="relative overflow-hidden border-b border-hairline bg-canvas"
        style={{ height: thumbHeight }}
      >
        <MotifTile motif={resolvedMotif} accent={accent} />
        {verified && !compact ? (
          <div className="absolute bottom-[12px] left-[12px] flex items-center gap-[6px] border border-hairline bg-canvas px-[8px] py-[4px]">
            <span
              aria-hidden="true"
              className="inline-block rounded-full"
              style={{ width: 7, height: 7, background: "var(--blue)" }}
            />
            <span className="font-mono text-[10px] text-ink-muted lowercase">verified</span>
          </div>
        ) : null}
      </div>

      {compact ? (
        // Landing-strip compact body (comp 154-157): 14px title + yellow price only.
        <div className="p-[14px]">
          <h3 className="mb-[8px] font-display text-[14px] font-semibold tracking-tight text-ink lowercase">
            {card.slug}
          </h3>
          <PricePill
            baseUnits={baseUnits}
            decimals={decimals}
            model={model}
            capBaseUnits={model === "metered" ? capUnits : undefined}
          />
        </div>
      ) : (
        <div className="p-[14px]">
          {/* lowercase title */}
          <h3 className="mb-[10px] font-display text-[15px] font-semibold tracking-tight text-ink lowercase">
            {card.slug}
          </h3>

          {/* creator row: colored avatar + name + "/100" reputation */}
          <div className="mb-[12px] flex items-center gap-[8px]">
            <span
              aria-hidden="true"
              className="inline-block shrink-0 rounded-full"
              style={{ width: 18, height: 18, background: creatorColor }}
            />
            <span className="font-mono text-[12px] text-ink-muted lowercase">
              {creatorName ?? `agent ${card.agentId}`}
            </span>
            <span aria-hidden="true" className="font-mono text-[11px] text-ink-faint">
              ·
            </span>
            <ReputationBadge feedbackCount={card.reputation} variant="score" />
          </div>

          {/* price + (optional) calls figure */}
          <div className="flex items-center justify-between">
            <PricePill
              baseUnits={baseUnits}
              decimals={decimals}
              model={model}
              capBaseUnits={model === "metered" ? capUnits : undefined}
            />
            {callsFmt !== null ? (
              <span className="font-mono text-[11px] text-ink-faint tabular-nums lowercase">
                {callsFmt}
              </span>
            ) : null}
          </div>
        </div>
      )}
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
