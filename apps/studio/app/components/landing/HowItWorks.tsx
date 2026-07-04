// HowItWorks - the inverted "paper" 5-step block, transcribed pixel-for-pixel from the
// LANDING how-it-works section of Design/Utter.dc.html (lines 126-139, data 968-974).
// The outer wrapper flips to the paper inversion tokens (off-white background,
// near-black ink) via var(--paper-bg) / var(--paper-ink), full-bleed, matching the comp.
//
// The five steps use the comp's EXACT copy: utter / build / verify / mint / earn.
import * as React from "react";

interface Step {
  n: string;
  title: string;
  desc: string;
}

// Exactly five steps, verbatim from the comp data (Utter.dc.html 968-974).
const STEPS: readonly Step[] = [
  { n: "1", title: "utter", desc: "describe the endpoint in one plain sentence." },
  { n: "2", title: "build", desc: "utter writes the handler and openapi spec." },
  { n: "3", title: "verify", desc: "sandboxed deploy, smoke tests, latency check." },
  { n: "4", title: "mint", desc: "onchain identity + bond, listed to the market." },
  { n: "5", title: "earn", desc: "agents pay per call in usdc. you keep 70%." },
];

export function HowItWorks(): React.ReactElement {
  return (
    <section
      data-testid="landing-howitworks"
      className="bg-paper-bg text-paper-ink"
    >
      <div className="mx-auto max-w-[1320px] px-[32px] py-[64px]">
        <div className="mb-[28px] font-mono text-[12px] uppercase tracking-[0.08em] text-red">
          how it works
        </div>
        {/* seamless 1px grid on a BLACK seam (comp 129) */}
        <div className="grid grid-cols-5 gap-px border border-paper-ink bg-paper-ink">
          {STEPS.map((step) => (
            <div
              key={step.n}
              data-testid="how-step"
              className="bg-paper-bg px-[20px] py-[28px] min-h-[180px]"
            >
              <div
                className="mb-[18px] flex items-center justify-center font-mono font-bold"
                style={{
                  width: 34,
                  height: 34,
                  background: "var(--paper-ink)",
                  color: "var(--paper-bg)",
                }}
              >
                {step.n}
              </div>
              <div className="mb-[8px] text-[17px] font-display font-semibold tracking-[-0.01em] lowercase">
                {step.title}
              </div>
              <div className="text-[13px] leading-[1.45] lowercase" style={{ color: "#4a4842" }}>
                {step.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
