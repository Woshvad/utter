// BuildStepBlock - one row of the deploy pipeline grid (consumed by BuildStream).
// Five states, each shape + color so meaning is never color-only:
//
//   pending   - hairline-outline square (not yet started)
//   active    - blue pulsing 2px-border square (running)
//   verifying - blue pulsing square (the verify gate)
//   done      - blue filled block
//   failed    - red triangle + the plain failure reason
//
// Glyph + status colors follow the comp (Design/Utter.dc.html 297-306, status colors
// 960-961): done = blue "done", running = yellow "running", pending = ink-faint
// "pending". Each row paints its own bg-raised so the parent's 1px-gap grid shows the
// hairline rules between rows.
//
// A status role announces the stage for screen readers (STU-02 a11y).
import * as React from "react";
import type { BuildStage } from "../../adapter/types";

export type BuildStepStatus = "pending" | "active" | "verifying" | "done" | "failed";

type Shape = "square" | "triangle";
type Color = "ink" | "blue" | "red" | "neutral";

interface StepVisual {
  shape: Shape;
  color: Color;
  pulse: boolean;
  filled: boolean;
}

const VISUAL: Record<BuildStepStatus, StepVisual> = {
  pending: { shape: "square", color: "neutral", pulse: false, filled: false },
  active: { shape: "square", color: "blue", pulse: true, filled: false },
  verifying: { shape: "square", color: "blue", pulse: true, filled: false },
  done: { shape: "square", color: "blue", pulse: false, filled: true },
  failed: { shape: "triangle", color: "red", pulse: false, filled: true },
};

const COLOR_VAR: Record<Color, string> = {
  ink: "var(--ink)",
  blue: "var(--blue)",
  red: "var(--red)",
  neutral: "var(--hairline)",
};

const STATUS_LABEL: Record<BuildStepStatus, string> = {
  pending: "pending",
  active: "running",
  verifying: "running",
  done: "done",
  failed: "failed",
};

/** Status-label color per the comp (done blue / running yellow / pending faint). */
const STATUS_COLOR: Record<BuildStepStatus, string> = {
  pending: "var(--ink-faint)",
  active: "var(--yellow)",
  verifying: "var(--yellow)",
  done: "var(--blue)",
  failed: "var(--red)",
};

/** The friendly per-stage title + description shown in the row (stepData 946-952). */
const STAGE_COPY: Record<BuildStage, { title: string; desc: string }> = {
  Generate: { title: "generate", desc: "writing handler + openapi from your sentence" },
  Deploy: { title: "deploy", desc: "sandboxed container, isolated egress" },
  Verify: { title: "verify", desc: "schema + smoke tests, latency check" },
  Mint: { title: "mint", desc: "erc-8004 identity + onchain registration" },
  Publish: { title: "publish", desc: "listed on marketplace, endpoint live" },
  Live: { title: "live", desc: "endpoint live, agents can pay per call" },
};

function Glyph({ v }: { v: StepVisual }): React.ReactElement {
  const color = COLOR_VAR[v.color];
  const anim = v.pulse ? "animate-utter-pulse" : undefined;
  const size = 16;
  if (v.shape === "triangle") {
    return (
      <span
        aria-hidden="true"
        className={anim}
        style={{
          width: 0,
          height: 0,
          borderLeft: `${size / 2}px solid transparent`,
          borderRight: `${size / 2}px solid transparent`,
          borderBottom: `${size}px solid ${color}`,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={anim}
      style={{
        width: size,
        height: size,
        background: v.filled ? color : "transparent",
        border: `2px solid ${color}`,
      }}
    />
  );
}

export interface BuildStepBlockProps {
  stage: BuildStage;
  status: BuildStepStatus;
  /** Plain failure reason (rendered only when status === "failed"). */
  reason?: string;
  /** Optional expandable log line for the stage. */
  log?: string;
}

export function BuildStepBlock({
  stage,
  status,
  reason,
  log,
}: BuildStepBlockProps): React.ReactElement {
  const v = VISUAL[status];
  const copy = STAGE_COPY[stage];
  const titleActive = status === "done" || status === "active" || status === "verifying";
  return (
    <div
      data-testid="build-step-block"
      data-stage={stage}
      data-status={status}
      data-shape={v.shape}
      data-color={v.color}
      role="status"
      aria-live="polite"
      className="flex items-center gap-[16px] bg-raised p-[16px_18px]"
    >
      <span className="flex h-[16px] w-[16px] flex-none items-center justify-center">
        <Glyph v={v} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={[
            "text-[15px] font-medium",
            titleActive ? "text-ink" : "text-ink-faint",
          ].join(" ")}
        >
          {copy.title}
        </div>
        <div className="font-mono text-[13px] text-ink-faint">{copy.desc}</div>
        {log ? (
          <span className="mt-[4px] font-mono text-[13px] text-ink-muted">{log}</span>
        ) : null}
        {status === "failed" && reason ? (
          <span
            className="mt-[4px] font-mono text-[13px] lowercase"
            style={{ color: "var(--red)" }}
          >
            {`${stage.toLowerCase()} failed: ${reason}.`}
          </span>
        ) : null}
      </div>
      <div
        className="font-mono text-[12px]"
        style={{ color: STATUS_COLOR[status] }}
      >
        {STATUS_LABEL[status]}
      </div>
    </div>
  );
}
