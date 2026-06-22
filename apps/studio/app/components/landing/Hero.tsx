// Hero - the landing front-door hero, transcribed from the LANDING section of
// Design/Utter.dc.html into React with the dark-Bauhaus tokens (no inline hex; the
// shapes use var(--token) inline styles exactly as AppShell's LogoLockup does).
//
// Dual-audience entry: the primary "start uttering" CTA serves creators (-> /create);
// the secondary "browse marketplace" CTA serves agent operators (-> /discover). The
// "$0.01 / call" line is STATIC display copy (mono), not a render of an on-chain
// amount, so it carries no UsdcAmount and introduces no money literal.
import * as React from "react";
import { Link } from "react-router";

/** The wordmark lockup: red circle + ink triangle + lowercase "utter" (the brand glyph,
 *  same primitive shapes as AppShell's LogoLockup). */
function Wordmark(): React.ReactElement {
  return (
    <div className="flex items-center gap-xs">
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{ width: 18, height: 18, background: "var(--red)" }}
      />
      <span
        aria-hidden="true"
        style={{
          width: 0,
          height: 0,
          borderTop: "6px solid transparent",
          borderBottom: "6px solid transparent",
          borderLeft: "10px solid var(--ink)",
        }}
      />
      <span className="text-heading font-display font-bold tracking-tighter text-ink lowercase">
        utter
      </span>
    </div>
  );
}

/** The asymmetric Bauhaus composition (blue square / red ring / yellow triangle / paper
 *  square). Purely decorative; aria-hidden so it is skipped by assistive tech. */
function HeroComposition(): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative hidden h-80 lg:block">
      <div
        className="absolute right-0 top-0"
        style={{ width: 200, height: 200, background: "var(--blue)" }}
      />
      <div
        className="absolute rounded-full"
        style={{ left: 16, top: 64, width: 176, height: 176, border: "22px solid var(--red)" }}
      />
      <div
        className="absolute right-12 bottom-0"
        style={{
          width: 0,
          height: 0,
          borderLeft: "76px solid transparent",
          borderRight: "76px solid transparent",
          borderBottom: "136px solid var(--yellow)",
        }}
      />
      <div
        className="absolute left-12 bottom-6"
        style={{ width: 104, height: 104, background: "var(--paper-bg)" }}
      />
    </div>
  );
}

/** One proof block in the three-up strip: a small glyph, a heading, and a one-line note. */
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
    <div className="border border-hairline bg-canvas p-lg">
      <div className="mb-sm">{glyph}</div>
      <div className="mb-xs text-heading font-display font-semibold tracking-tight text-ink lowercase">
        {title}
      </div>
      <div className={`text-body text-ink-muted ${mono ? "font-mono text-caption-mono" : ""}`}>
        {note}
      </div>
    </div>
  );
}

export function Hero(): React.ReactElement {
  return (
    <section data-testid="landing-hero" className="flex flex-col gap-xl">
      <div className="grid grid-cols-1 items-center gap-xl py-xl lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex flex-col">
          <Wordmark />
          {/* kicker line */}
          <div className="mt-lg mb-md flex items-center gap-xs font-mono text-caption-mono tracking-wide text-yellow">
            <span
              aria-hidden="true"
              className="inline-block"
              style={{ width: 8, height: 8, background: "var(--yellow)" }}
            />
            sentence -&gt; paid api -&gt; onchain
          </div>

          <h1 className="text-hero font-display font-bold tracking-tighter text-ink lowercase">
            you utter a sentence; you get a paid api.
          </h1>

          <p className="mt-md max-w-md text-body text-ink-muted lowercase">
            describe an endpoint in plain english. utter writes, deploys, verifies and
            lists it. agents discover it and pay per call in usdc. you earn the majority.
          </p>

          <div className="mt-lg flex flex-wrap items-center gap-sm">
            <Link
              to="/create"
              className="inline-flex items-center gap-xs px-lg py-md text-body font-display font-semibold text-canvas"
              style={{ background: "var(--red)" }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 0,
                  height: 0,
                  borderTop: "6px solid transparent",
                  borderBottom: "6px solid transparent",
                  borderLeft: "10px solid var(--canvas)",
                }}
              />
              start uttering
            </Link>
            <Link
              to="/discover"
              className="inline-flex items-center px-lg py-md text-body font-mono text-ink border border-hairline lowercase"
            >
              browse marketplace
            </Link>
          </div>
        </div>

        <HeroComposition />
      </div>

      {/* proof strip: three blocks, stacking to one column on mobile */}
      <div className="grid grid-cols-1 gap-px sm:grid-cols-3">
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
          note="$0.01 / call in usdc · you keep 90%"
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
