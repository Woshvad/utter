// HowItWorks - the inverted "paper" 5-step block, transcribed from the LANDING
// how-it-works section of Design/Utter.dc.html. The outer wrapper flips to the paper
// inversion tokens (off-white background, near-black ink) via var(--paper-bg) /
// var(--paper-ink) inline styles, matching the design's paper block.
//
// The five steps follow the product pipeline (CLAUDE.md): utter a sentence -> generate
// and sandbox-deploy -> verify the response gate -> mint an on-chain identity -> list it
// so agents pay per call.
import * as React from "react";

interface Step {
  n: number;
  title: string;
  desc: string;
}

// Exactly five steps, derived from the Utter pipeline. Terse, lowercase, accurate.
const STEPS: readonly Step[] = [
  { n: 1, title: "utter a sentence", desc: "describe the endpoint you want in plain english." },
  { n: 2, title: "generate + deploy", desc: "utter writes the code and deploys it in an isolated sandbox." },
  { n: 3, title: "verify", desc: "the response passes validation before any charge - the escrow gate." },
  { n: 4, title: "mint identity", desc: "the endpoint gets an on-chain erc-8004 identity." },
  { n: 5, title: "list + get paid", desc: "agents discover it and pay per call in usdc. you keep the majority." },
];

export function HowItWorks(): React.ReactElement {
  return (
    <section
      data-testid="landing-howitworks"
      style={{ background: "var(--paper-bg)", color: "var(--paper-ink)" }}
    >
      <div className="mx-auto max-w-6xl px-xl py-xl">
        <div className="mb-lg font-mono text-caption-mono uppercase tracking-wide text-red">
          how it works
        </div>
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step) => (
            <div key={step.n} data-testid="how-step" className="flex flex-col">
              <div
                className="mb-md flex items-center justify-center font-mono font-bold"
                style={{
                  width: 34,
                  height: 34,
                  background: "var(--paper-ink)",
                  color: "var(--paper-bg)",
                }}
              >
                {step.n}
              </div>
              <div className="mb-xs text-body font-display font-semibold tracking-tight lowercase">
                {step.title}
              </div>
              <div className="text-caption-mono leading-snug lowercase" style={{ opacity: 0.7 }}>
                {step.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
