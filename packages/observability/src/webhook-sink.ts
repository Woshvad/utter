// webhook-sink.ts - a best-effort reconcile alert sink for the provisioning/ops track.
//
// SEPARATE from the OBS-02 alerts.ts AlertSink (which is gated on ALERT_SINK_URL and
// is a fail-loud operator stub). This sink forwards SECURITY-RELEVANT reconcile-loop
// events (a failed reap of an untrusted container, a runaway quarantine, a deferred
// launch) to an operator webhook. It is wired at the deployer's buildReconcileLoop.
//
// BEST-EFFORT and INFALLIBLE: the reconcile loop calls onError INLINE inside a tick,
// so neither emit nor the webhook poster may EVER throw back into the loop. The poster
// is fire-and-forget (no await), .catch'es the fetch promise, AND is wrapped in
// try/catch so even a synchronous throw from fetch is swallowed. emit is wrapped in
// try/catch too. ALERT_WEBHOOK_URL unset/blank selects a pure no-op sink (no fetch, no
// network) so the autonomous suite never reaches a network path - mirroring the
// existing selectAlertSink / ALERT_SINK_URL gate, but with a DISTINCT env var.
//
// Dependency-free: only fetch / process. NEVER forwards secret material: the event
// carries only the typed reconcile fields (phase / message / containerId / resourceId).
import { JsonLogger } from "./jsonlog";

/** The security-relevant reconcile events this sink forwards. */
export interface ReconcileAlertEvent {
  /** Which class of reconcile event this is (maps from the reconcile phase). */
  kind:
    | "reap_failure"
    | "runaway_quarantine"
    | "capacity_defer"
    | "tick_failure"
    | "launch_failure";
  /** The reconcile phase that produced it (non-secret). */
  phase: string;
  /** A short non-secret message (the reconcile error message). */
  message: string;
  /** The container id involved, if known (non-secret). */
  containerId?: string;
  /** The resourceId involved, if known (non-secret). */
  resourceId?: string;
  /** When the event was produced (epoch ms). */
  ts: number;
}

/** The sink reconcile alert events are emitted to. Injectable. */
export interface ReconcileEventSink {
  emit(e: ReconcileAlertEvent): void;
}

/** In-memory sink (test default): collects emitted events for assertions. */
export class CaptureReconcileSink implements ReconcileEventSink {
  readonly events: ReconcileAlertEvent[] = [];
  emit(e: ReconcileAlertEvent): void {
    this.events.push(e);
  }
}

/** A fetch-shaped function (the global fetch signature), injectable for tests. */
type FetchLike = (input: string, init?: unknown) => Promise<unknown>;

/** Options for {@link makeWebhookPoster}. */
export interface WebhookPosterOpts {
  /** The operator webhook URL to POST events to. */
  url: string;
  /** The fetch implementation (defaults to the global fetch). Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Optional logger for a best-effort "post failed" warn (kind only, never the url). */
  logger?: JsonLogger;
}

/**
 * Build a fire-and-forget webhook poster. The returned function POSTs the event as
 * JSON and returns VOID IMMEDIATELY (it does NOT await), so a reconcile tick is never
 * blocked. The fetch promise has a `.catch` that logs a non-secret "post failed" warn
 * (the kind only, never the url). The whole call is additionally wrapped in try/catch
 * so even a SYNCHRONOUS throw from fetchImpl is swallowed - the poster can never throw
 * back into the loop.
 */
export function makeWebhookPoster(opts: WebhookPosterOpts): (e: ReconcileAlertEvent) => void {
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  return (e: ReconcileAlertEvent): void => {
    try {
      const result = doFetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
      });
      // A rejected fetch (network down, non-2xx that throws, etc.) must not surface as
      // an unhandled rejection: attach a .catch that only logs the kind (never the url).
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => {
          opts.logger?.warn("alert webhook post failed", { kind: e.kind });
        });
      }
    } catch {
      // A SYNCHRONOUS throw from fetchImpl (a misbehaving impl) is swallowed too.
      opts.logger?.warn("alert webhook post failed", { kind: e.kind });
    }
  };
}

/** A pure no-op sink: emit does nothing, makes no fetch, touches no network. */
class NoopReconcileEventSink implements ReconcileEventSink {
  emit(_e: ReconcileAlertEvent): void {
    // Intentionally empty: ALERT_WEBHOOK_URL is unset, so there is no webhook to post to.
  }
}

/**
 * Env-driven reconcile event sink selection (mirrors selectAlertSink, with a DISTINCT
 * env var ALERT_WEBHOOK_URL). When ALERT_WEBHOOK_URL is unset/blank, returns a pure
 * no-op sink (no fetch, no network) so the autonomous suite never reaches a network
 * path. Otherwise returns a sink whose emit (1) logs the event via the logger and
 * (2) fires the best-effort webhook poster. emit is INFALLIBLE: its whole body is
 * wrapped in try/catch so it can at most log and return, never throw - the reconcile
 * loop calls it inline inside a tick.
 */
export function selectReconcileEventSink(
  env: NodeJS.ProcessEnv = process.env,
  logger?: JsonLogger,
): ReconcileEventSink {
  const url = (env.ALERT_WEBHOOK_URL ?? "").trim();
  if (url.length === 0) {
    return new NoopReconcileEventSink();
  }
  const post = makeWebhookPoster({ url, logger });
  return {
    emit(e: ReconcileAlertEvent): void {
      try {
        logger?.warn("reconcile alert", {
          kind: e.kind,
          phase: e.phase,
          containerId: e.containerId,
          resourceId: e.resourceId,
          message: e.message,
        });
        post(e);
      } catch {
        // emit must be infallible: swallow anything so a tick never throws.
      }
    },
  };
}
