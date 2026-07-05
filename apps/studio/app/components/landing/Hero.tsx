// Hero - the landing front-door hero, transcribed pixel-for-pixel from the LANDING
// section of Design/Utter.dc.html (lines 84-122) into React with the dark-Bauhaus
// tokens (no inline hex; the shapes use var(--token) inline styles exactly as the
// header lockup does).
//
// The wordmark lives ONLY in the header (routes/_index.tsx); the hero body starts with
// the eyebrow per the comp. Dual-audience entry: the primary "start uttering" CTA serves
// creators (-> /create); the secondary "browse marketplace" CTA serves agent operators
// (-> /discover). The "$0.01 / call" line is STATIC display copy (mono), not a render of
// an on-chain amount, so it carries no UsdcAmount and introduces no money literal.
import * as React from "react";
import { Link } from "react-router";

/** The asymmetric Bauhaus composition (blue square / red ring / yellow triangle / paper
 *  square), 380px tall and ALWAYS visible (comp 98-103). Purely decorative; aria-hidden
 *  so it is skipped by assistive tech. */
function HeroComposition(): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative hidden h-[380px] lg:block">
      <div
        className="absolute right-0 top-0"
        style={{ width: 240, height: 240, background: "var(--blue)" }}
      />
      <div
        className="absolute left-[20px] top-[80px] rounded-full"
        style={{ width: 200, height: 200, border: "24px solid var(--red)" }}
      />
      <div
        className="absolute right-[60px] bottom-0"
        style={{
          width: 0,
          height: 0,
          borderLeft: "90px solid transparent",
          borderRight: "90px solid transparent",
          borderBottom: "160px solid var(--yellow)",
        }}
      />
      <div
        className="absolute left-[60px] bottom-[30px]"
        style={{ width: 120, height: 120, background: "var(--paper)" }}
      />
    </div>
  );
}

/** One proof block in the seamless three-up grid: a small glyph, a heading, and a
 *  one-line note (comp 107-121). */
function ProofBlock({
  glyph,
  title,
  note,
  mono,
}: {
  glyph: React.ReactNode;
  title: string;
  note: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="bg-canvas p-[28px]">
      <div className="mb-[16px]">{glyph}</div>
      <div className="mb-[6px] text-[22px] font-display font-semibold tracking-[-0.02em] text-ink lowercase">
        {title}
      </div>
      <div
        className={`text-[14px] text-ink-muted ${mono ? "font-mono" : ""}`}
      >
        {note}
      </div>
    </div>
  );
}

export function Hero(): React.ReactElement {
  return (
    <section data-testid="landing-hero" className="flex flex-col">
      <div className="grid grid-cols-1 items-center gap-[32px] pb-[40px] pt-[40px] lg:grid-cols-[1.1fr_0.9fr] lg:gap-[48px] lg:pt-[72px] lg:pb-[64px]">
        <div className="flex flex-col">
          {/* eyebrow: 8px yellow square + uppercase mono kicker with real -> arrows.
              Centered on mobile (a top kicker), left-aligned from lg (the comp). */}
          <div className="mb-[24px] flex items-center justify-center gap-[8px] font-mono text-[12px] tracking-[0.08em] text-yellow lg:justify-start">
            <span
              aria-hidden="true"
              className="inline-block"
              style={{ width: 8, height: 8, background: "var(--yellow)" }}
            />
            SENTENCE → PAID API → ONCHAIN
          </div>

          <h1 className="mb-[24px] text-[40px] font-display font-bold leading-[0.98] tracking-[-0.04em] text-ink lowercase lg:text-[64px]">
            you utter a sentence;
            <br />
            you get a paid api.
          </h1>

          <p className="mb-[36px] max-w-[440px] text-[18px] leading-[1.5] text-ink-muted lowercase">
            describe an endpoint in plain english. utter writes, deploys, verifies and
            lists it. agents discover it and pay per call in usdc. you earn the majority.
          </p>

          <div className="flex flex-col gap-[12px] sm:flex-row sm:items-center">
            <Link
              to="/create"
              className="inline-flex w-full items-center justify-center gap-[10px] px-[26px] py-[16px] text-[15px] font-display font-semibold text-white sm:w-auto sm:justify-start"
              style={{ background: "var(--red)" }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 0,
                  height: 0,
                  borderTop: "6px solid transparent",
                  borderBottom: "6px solid transparent",
                  borderLeft: "10px solid #fff",
                }}
              />
              start uttering
            </Link>
            <Link
              to="/discover"
              className="inline-flex w-full items-center justify-center border border-hairline px-[26px] py-[16px] text-[15px] font-mono text-ink lowercase sm:w-auto"
            >
              browse marketplace
            </Link>
          </div>

          {/* Mobile-only Bauhaus composition: the four hero shapes (blue square / red ring /
              yellow triangle / paper square), centered with the ring overlapping the square
              for depth and a lifted paper accent, so the phone hero keeps the brand geometry
              the desktop composition carries (hidden < lg). Purely decorative. */}
          <div
            aria-hidden="true"
            className="mt-[44px] flex items-end justify-center gap-[22px] lg:hidden"
          >
            {/* blue square */}
            <div style={{ width: 72, height: 72, background: "var(--blue)" }} />
            {/* red ring overlapping the square (blue shows through the hollow center), lifted */}
            <div
              className="-ml-[36px] mb-[8px] rounded-full"
              style={{ width: 58, height: 58, border: "15px solid var(--red)" }}
            />
            {/* yellow triangle - the tallest form */}
            <div
              style={{
                width: 0,
                height: 0,
                borderLeft: "33px solid transparent",
                borderRight: "33px solid transparent",
                borderBottom: "62px solid var(--yellow)",
              }}
            />
            {/* small paper square accent, lifted to break the baseline */}
            <div className="mb-[10px]" style={{ width: 40, height: 40, background: "var(--paper)" }} />
          </div>
        </div>

        <HeroComposition />
      </div>

      {/* proof strip: seamless 1px hairline grid (comp 106-122) */}
      <div className="mb-[8px] grid grid-cols-1 gap-px border border-hairline bg-hairline sm:grid-cols-3">
        <ProofBlock
          glyph={
            <span
              className="inline-block rounded-full"
              style={{ width: 14, height: 14, background: "var(--red)" }}
            />
          }
          title="live in ~90s"
          note="sentence to deployed, verified endpoint."
        />
        <ProofBlock
          glyph={<span className="inline-block" style={{ width: 14, height: 14, background: "var(--yellow)" }} />}
          title="earn per call"
          note="$0.01 / call in usdc · you keep 70%"
          mono
        />
        <ProofBlock
          glyph={
            <span
              style={{
                display: "inline-block",
                width: 0,
                height: 0,
                borderLeft: "8px solid transparent",
                borderRight: "8px solid transparent",
                borderBottom: "14px solid var(--blue)",
              }}
            />
          }
          title="paid by agents"
          note="discovered & called over mcp, autonomously."
        />
      </div>
    </section>
  );
}
