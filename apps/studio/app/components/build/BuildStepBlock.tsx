// BuildStepBlock - one square step of the deploy pipeline (consumed by Plan 04's
// BuildStream). Five states, each shape + color so meaning is never color-only:
//
//   pending   - ink-outline square (not yet started)
//   active    - pulsing square (running)
//   verifying - blue pulsing square (the verify gate)
//   done      - filled block
//   failed    - red triangle + the plain failure reason
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
  active: { shape: "square", color: "ink", pulse: true, filled: false },
  verifying: { shape: "square", color: "blue", pulse: true, filled: false },
  done: { shape: "square", color: "ink", pulse: false, filled: true },
  failed: { shape: "triangle", color: "red", pulse: false, filled: true },
};

const COLOR_VAR: Record<Color, string> = {
  ink: "var(--ink)",
  blue: "var(--blue)",
  red: "var(--red)",
  neutral: "var(--ink-faint)",
};

const STATUS_LABEL: Record<BuildStepStatus, string> = {
  pending: "pending",
  active: "running",
  verifying: "verifying",
  done: "done",
  failed: "failed",
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
  return (
    <div
      data-testid="build-step-block"
      data-stage={stage}
      data-status={status}
      data-shape={v.shape}
      data-color={v.color}
      role="status"
      aria-live="polite"
      className="flex items-start gap-sm border border-hairline bg-raised p-sm"
    >
      <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center">
        <Glyph v={v} />
      </span>
      <div className="flex min-w-0 flex-col gap-2xs">
        <div className="flex items-center gap-xs">
          <span className="text-label font-display text-ink lowercase">{stage}</span>
          <span className="font-mono text-caption-mono text-ink-faint lowercase">
            {STATUS_LABEL[status]}
          </span>
        </div>
        {log ? (
          <span className="font-mono text-caption-mono text-ink-muted">{log}</span>
        ) : null}
        {status === "failed" && reason ? (
          <span className="font-mono text-caption-mono lowercase" style={{ color: "var(--red)" }}>
            {`${stage.toLowerCase()} failed: ${reason}.`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
