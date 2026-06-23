// BuildStream - the STU-02 live deploy log (the signature utter -> live sequence).
//
// It opens an EventSource on the SSE route (resources.$id.events) and applies each
// `stage` BuildEvent to the per-stage BuildStepBlock states, snapping the six blocks
// Generate -> Deploy -> Verify -> Mint -> Publish -> Live into place. When the final
// Live -> ok event lands it resolves to the comp's rich live moment: a 48px filling
// red circle, "<slug> is live.", the blue live URL, the yellow price, and the
// test-it / view-listing / utter-another buttons + the conversational iterate bar.
//
// a11y (STU-02): an aria-live="polite" SR region announces each stage label as it
// arrives, so a screen-reader user follows the build without watching the blocks.
//
// The EventSource closes on unmount and on error (SSE auto-reconnects otherwise -
// Pattern 1). The component never re-derives money: the live price is rendered by
// the single UsdcAmount surface from base units the caller passes in, or as a
// comp-style sample string when the caller has no runtime base units mid-build.
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

/**
 * Return the liveUrl only when it parses as an http(s) URL, else null (IN-01). React
 * escapes text but does NOT block `javascript:`/`data:` schemes in an href; if a live
 * adapter ever surfaces a resource-controlled URL here it would be a reflected-URL XSS
 * sink. Validating the scheme at the single render surface closes that off - a
 * non-http(s) value renders as plain text instead of a clickable anchor.
 */
export function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
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
  /** The created resource id (drives the "test it" deep link to the playground). */
  resourceId?: string;
  /** The slug-like name shown in the "<slug> is live." headline. */
  liveName?: string;
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
  resourceId,
  liveName,
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
  // IN-01: only render the live URL as a clickable anchor when its scheme is http(s).
  const safeLiveUrl = safeHttpUrl(liveUrl);
  const name = liveName ?? "your-endpoint";
  const bondFmt = "$5";
  const playgroundHref = resourceId ? `/resources/${resourceId}` : "/discover";

  return (
    <div data-testid="build-stream" className="mt-[24px]">
      {/* SR live-region: announces each stage as it streams (a11y STU-02). */}
      <div aria-live="polite" className="sr-only" data-testid="build-stream-live">
        {announce}
      </div>

      {!isLive ? (
        <>
          {/* BUILD STREAM header + reset */}
          <div className="mb-[14px] flex items-center justify-between">
            <div className="font-mono text-[12px] tracking-[0.06em] text-ink-faint">
              BUILD STREAM
            </div>
            <a
              href="/create"
              data-testid="build-reset"
              className="cursor-pointer font-mono text-[12px] text-ink-muted"
            >
              reset
            </a>
          </div>

          {/* seamless 1px grid - each cell paints its own bg */}
          <div className="flex flex-col gap-px border border-hairline bg-hairline">
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
        </>
      ) : (
        <>
          {/* LIVE moment - the rich live card (comp 313-337) */}
          <div data-testid="build-live-moment" className="border border-hairline bg-raised">
            <div className="flex items-center gap-[20px] border-b border-hairline p-[28px]">
              <span
                aria-hidden="true"
                className="flex-none animate-utter-fill rounded-full"
                style={{ width: 48, height: 48, background: "var(--red)" }}
              />
              <div className="flex-1">
                <div className="mb-[4px] font-mono text-[13px] text-ink-faint">LIVE</div>
                <div className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
                  {name} is live.
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-[14px] border-b border-hairline p-[18px_28px]">
              {safeLiveUrl ? (
                <a
                  href={safeLiveUrl}
                  data-testid="build-live-url"
                  className="font-mono text-[14px] text-blue"
                >
                  {safeLiveUrl}
                </a>
              ) : liveUrl ? (
                // Non-http(s) scheme: render as inert text, never a clickable href (IN-01).
                <span
                  data-testid="build-live-url-text"
                  className="font-mono text-[14px] text-ink-muted"
                >
                  {liveUrl}
                </span>
              ) : (
                <span data-testid="build-live-url" className="font-mono text-[14px] text-blue">
                  {`https://${name}.resources.utter.app`}
                </span>
              )}
              <span className="font-mono text-[13px] text-yellow">
                {priceBaseUnits !== undefined && decimals !== undefined ? (
                  <>
                    <UsdcAmount baseUnits={priceBaseUnits} decimals={decimals} />
                    {" / call"}
                  </>
                ) : (
                  "$0.0100 / call"
                )}
              </span>
              <span className="font-mono text-[12px] text-ink-faint">
                {`· verified · ${bondFmt} bond`}
              </span>
            </div>

            <div className="flex gap-[12px] p-[18px_28px]">
              <a
                href={playgroundHref}
                data-testid="build-test-it"
                className="flex items-center gap-[9px] border-0 bg-red px-[20px] py-[12px] text-[14px] font-semibold text-white"
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
                test it
              </a>
              <a
                href="/discover"
                className="border border-hairline bg-transparent px-[20px] py-[12px] font-mono text-[14px] text-ink"
              >
                view listing
              </a>
              <a
                href="/create"
                data-testid="build-reset"
                className="border border-hairline bg-transparent px-[20px] py-[12px] font-mono text-[14px] text-ink-muted"
              >
                utter another
              </a>
            </div>
          </div>

          {/* conversational iterate bar */}
          <div className="mt-[14px] flex items-center gap-[12px] border border-hairline bg-raised p-[14px]">
            <span
              aria-hidden="true"
              style={{
                width: 0,
                height: 0,
                borderTop: "5px solid transparent",
                borderBottom: "5px solid transparent",
                borderLeft: "9px solid var(--ink-faint)",
              }}
            />
            <span className="flex-1 text-[14px] text-ink-faint">
              {'iterate: "return json instead", "cap at $5/day", "add auth header"…'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
