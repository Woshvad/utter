// BuildStream - the STU-02 live deploy log (the signature utter -> live sequence).
//
// It opens an EventSource on the SSE route (resources.$id.events) and applies each
// `stage` BuildEvent to the per-stage BuildStepBlock states, snapping the six blocks
// Generate -> Deploy -> Verify -> Mint -> Publish -> Live into place. When the final
// Live -> ok event lands it resolves to the filled-circle + live URL + price moment.
//
// a11y (STU-02): an aria-live="polite" SR region announces each stage label as it
// arrives, so a screen-reader user follows the build without watching the blocks.
//
// The EventSource closes on unmount and on error (SSE auto-reconnects otherwise -
// Pattern 1). The component never re-derives money: the live price is rendered by
// the single UsdcAmount surface from base units the caller passes in.
import * as React from "react";
import {
  BUILD_STAGES,
  type BuildEvent,
  type BuildStage,
  type BuildStageStatus,
} from "../../adapter/types";
import { BuildStepBlock, type BuildStepStatus } from "./BuildStepBlock";
import { UsdcAmount } from "../primitives/UsdcAmount";

/** Map a streamed stage status to the BuildStepBlock visual status. Verify-while-
 *  running gets the blue "verifying" treatment (the gate beat); a failure becomes
 *  the red triangle. */
function toStepStatus(stage: BuildStage, status: BuildStageStatus): BuildStepStatus {
  if (status === "error") return "failed";
  if (status === "ok") return "done";
  // running / pending
  if (stage === "Verify") return "verifying";
  if (status === "running") return "active";
  return "pending";
}

interface StageState {
  status: BuildStepStatus;
  log?: string;
  reason?: string;
}

type StageMap = Record<BuildStage, StageState>;

function initialStages(): StageMap {
  const map = {} as StageMap;
  for (const stage of BUILD_STAGES) map[stage] = { status: "pending" };
  return map;
}

/** Apply one streamed BuildEvent to the stage map (pure - testable). */
export function applyStage(prev: StageMap, ev: BuildEvent): StageMap {
  return {
    ...prev,
    [ev.stage]: {
      status: toStepStatus(ev.stage, ev.status),
      log: ev.log,
      reason: ev.status === "error" ? ev.log : undefined,
    },
  };
}

export interface BuildStreamProps {
  /** The SSE events URL returned by the create action (adapter.createResource). */
  eventsUrl: string;
  /** The live URL shown at the "it's live" moment. */
  liveUrl?: string;
  /** The per-call price in base units (rendered only via UsdcAmount, no literal). */
  priceBaseUnits?: bigint;
  /** Decimals from a runtime read (passed straight to UsdcAmount). */
  decimals?: number;
  /** Injectable EventSource factory for tests (defaults to the global). */
  eventSourceFactory?: (url: string) => EventSourceLike;
}

/** The minimal EventSource surface BuildStream needs (so tests can inject a fake). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export function BuildStream({
  eventsUrl,
  liveUrl,
  priceBaseUnits,
  decimals,
  eventSourceFactory,
}: BuildStreamProps): React.ReactElement {
  const [stages, setStages] = React.useState<StageMap>(initialStages);
  const [announce, setAnnounce] = React.useState<string>("");

  React.useEffect(() => {
    const factory =
      eventSourceFactory ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    const es = factory(eventsUrl);
    es.addEventListener("stage", (e) => {
      const ev = JSON.parse(e.data) as BuildEvent;
      setStages((s) => applyStage(s, ev));
      setAnnounce(`${ev.stage.toLowerCase()} ${ev.status}`);
    });
    es.addEventListener("error", () => es.close()); // SSE auto-reconnects unless closed
    return () => es.close();
  }, [eventsUrl, eventSourceFactory]);

  const isLive = stages.Live?.status === "done";

  return (
    <div data-testid="build-stream" className="flex flex-col gap-sm">
      {/* SR live-region: announces each stage as it streams (a11y STU-02). */}
      <div aria-live="polite" className="sr-only" data-testid="build-stream-live">
        {announce}
      </div>

      <div className="flex flex-col gap-xs">
        {BUILD_STAGES.map((stage) => {
          const s = stages[stage];
          return (
            <BuildStepBlock
              key={stage}
              stage={stage}
              status={s.status}
              log={s.log}
              reason={s.reason}
            />
          );
        })}
      </div>

      {isLive ? (
        <div
          data-testid="build-live-moment"
          className="flex items-center gap-sm border border-hairline bg-raised p-md"
        >
          {/* filled circle = live (shape + color, the live motif) */}
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{ width: 16, height: 16, background: "var(--red)" }}
          />
          <span className="text-label font-display text-ink lowercase">live</span>
          {liveUrl ? (
            <a
              href={liveUrl}
              data-testid="build-live-url"
              className="font-mono text-caption-mono text-blue underline"
            >
              {liveUrl}
            </a>
          ) : null}
          {priceBaseUnits !== undefined && decimals !== undefined ? (
            <span className="font-mono text-caption-mono text-ink-muted">
              <UsdcAmount baseUnits={priceBaseUnits} decimals={decimals} />
              {"/call"}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
