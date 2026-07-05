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
  /** The posted bond in base units (rendered via UsdcAmount only when > 0; no literal). */
  bondBaseUnits?: bigint;
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
  bondBaseUnits,
  decimals,
  eventSourceFactory,
}: BuildStreamProps): React.ReactElement {
  const [stages, setStages] = React.useState<StageMap>(initialStages);
  const [announce, setAnnounce] = React.useState<string>("");
  // True when the stream dropped BEFORE reaching a terminal state (Live ok or a stage
  // error). EventSource surfaces a non-200 open (the new pre-stream 429/503 admission
  // denials) as a bare `error` with no body, so without this the six blocks would
  // freeze at "pending" forever and the server's Retry-After would be invisible. A
  // clean server close after completion also fires `error`, so we gate on whether the
  // build actually settled (settledRef) to avoid a false interruption banner.
  const [interrupted, setInterrupted] = React.useState(false);
  // Bumped by the Retry button to re-run the effect and reopen the EventSource.
  const [attempt, setAttempt] = React.useState(0);
  const settledRef = React.useRef(false);

  React.useEffect(() => {
    settledRef.current = false;
    setInterrupted(false);
    setStages(initialStages());
    const factory =
      eventSourceFactory ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    const es = factory(eventsUrl);
    es.addEventListener("stage", (e) => {
      const ev = JSON.parse(e.data) as BuildEvent;
      // A build settles at Live:ok or at any stage error; after that a stream close is
      // normal, not an interruption.
      if ((ev.stage === "Live" && ev.status === "ok") || ev.status === "error") {
        settledRef.current = true;
      }
      setStages((s) => applyStage(s, ev));
      setAnnounce(`${ev.stage.toLowerCase()} ${ev.status}`);
    });
    es.addEventListener("error", () => {
      es.close(); // SSE auto-reconnects unless closed
      // Only a drop BEFORE the build settled is a real interruption to surface.
      if (!settledRef.current) setInterrupted(true);
    });
    return () => es.close();
  }, [eventsUrl, eventSourceFactory, attempt]);

  const onRetry = React.useCallback(() => setAttempt((n) => n + 1), []);

  const isLive = stages.Live?.status === "done";
  // IN-01: only render the live URL as a clickable anchor when its scheme is http(s).
  const safeLiveUrl = safeHttpUrl(liveUrl);
  const name = liveName ?? "your-endpoint";
  const playgroundHref = resourceId ? `/resources/${resourceId}` : "/discover";

  // Overall build progress: completed stages, plus HALF-credit for the one in-flight
  // stage so the bar visibly advances mid-stage (a long generate/deploy call is never
  // "static"). The fill pulses while a stage runs and turns red if a stage failed.
  const total = BUILD_STAGES.length;
  const doneCount = BUILD_STAGES.filter((st) => stages[st]?.status === "done").length;
  const failedStage = BUILD_STAGES.find((st) => stages[st]?.status === "failed");
  const runningStage = BUILD_STAGES.find(
    (st) => stages[st]?.status === "active" || stages[st]?.status === "verifying",
  );
  const running = !failedStage && runningStage !== undefined;
  const progressPct = Math.min(
    100,
    Math.round(((doneCount + (running ? 0.5 : 0)) / total) * 100),
  );
  const progressLabel = failedStage
    ? `stopped at ${failedStage.toLowerCase()}`
    : running && runningStage
      ? `step ${doneCount + 1} of ${total} · ${runningStage.toLowerCase()}…`
      : `${doneCount} of ${total} complete`;

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

          {/* Overall progress bar: advances one step per completed stage (with half-credit
              + a pulse for the in-flight stage) so a long-running stage never looks frozen.
              Turns red and reports where it halted on a failure. */}
          <div data-testid="build-progress" className="mb-[14px]">
            <div className="mb-[6px] flex items-center justify-between font-mono text-[11px] tracking-[0.06em] text-ink-faint lowercase">
              <span data-testid="build-progress-label">{progressLabel}</span>
              <span className="tabular-nums">{progressPct}%</span>
            </div>
            <div className="h-[6px] w-full overflow-hidden border border-hairline bg-canvas">
              <div
                data-testid="build-progress-fill"
                data-pct={progressPct}
                className={
                  failedStage
                    ? "h-full bg-red"
                    : running
                      ? "h-full bg-blue animate-utter-pulse"
                      : "h-full bg-blue"
                }
                style={{ width: `${progressPct}%`, transition: "width 400ms ease" }}
              />
            </div>
          </div>

          {/* Interruption banner: the stream dropped before the build finished
              (commonly a rate-limit / capacity 429/503 on the events route, which
              EventSource cannot surface as a body). The endpoint may still be
              building server-side; retry reopens the stream. */}
          {interrupted ? (
            <div
              data-testid="build-interrupted"
              className="mb-[14px] flex items-center justify-between gap-[12px] border border-hairline bg-raised p-[14px]"
            >
              <span className="font-mono text-[12px] text-ink-muted lowercase">
                build stream interrupted (you may be rate limited). your endpoint may
                still be building — retry to reconnect.
              </span>
              <button
                type="button"
                data-testid="build-retry"
                onClick={onRetry}
                className="flex-none cursor-pointer border border-hairline bg-transparent px-[14px] py-[8px] font-mono text-[12px] text-ink lowercase"
              >
                retry
              </button>
            </div>
          ) : null}

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
                // No server-known URL yet (the deployed slug is assigned server-side and
                // is not carried on the SSE stream): link to the canonical resource page
                // instead of fabricating a URL.
                <a
                  href={playgroundHref}
                  data-testid="build-live-url"
                  className="font-mono text-[14px] text-blue"
                >
                  view your endpoint →
                </a>
              )}
              {/* Real per-call price (the creator's entered basePrice), rendered only via
                  UsdcAmount at runtime decimals. Omitted rather than faked when absent. */}
              {priceBaseUnits !== undefined && decimals !== undefined ? (
                <span className="font-mono text-[13px] text-yellow">
                  <UsdcAmount baseUnits={priceBaseUnits} decimals={decimals} />
                  {" / call"}
                </span>
              ) : null}
              {/* verified is real (the build passed the Verify gate); the bond is shown
                  only when a real bond > 0 was posted (testnet bonds are commonly 0). */}
              <span className="font-mono text-[12px] text-ink-faint">
                {"· verified"}
                {bondBaseUnits !== undefined && bondBaseUnits > 0n && decimals !== undefined ? (
                  <>
                    {" · "}
                    <UsdcAmount baseUnits={bondBaseUnits} decimals={decimals} />
                    {" bond"}
                  </>
                ) : null}
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

          {/* conversational iterate bar - a real refine-and-re-utter input that
              prefills the create screen via /create?prompt=<text> */}
          <form
            method="get"
            action="/create"
            data-testid="build-iterate"
            className="mt-[14px] flex items-center gap-[12px] border border-hairline bg-raised p-[14px]"
          >
            <button
              type="submit"
              aria-label="refine and re-utter"
              className="flex-none cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-blue"
              style={{
                width: 0,
                height: 0,
                borderTop: "5px solid transparent",
                borderBottom: "5px solid transparent",
                borderLeft: "9px solid var(--ink-faint)",
              }}
            />
            <input
              type="text"
              name="prompt"
              aria-label="refine prompt"
              placeholder={'iterate: "return json instead", "cap at $5/day", "add auth header"…'}
              className="w-full flex-1 border-0 bg-transparent text-[14px] text-ink placeholder:text-ink-faint outline-none focus-visible:ring-0"
            />
          </form>
        </>
      )}
    </div>
  );
}
