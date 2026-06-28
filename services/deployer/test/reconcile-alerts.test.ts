// reconcile-alerts.test.ts - the buildReconcileLoop onError -> alert mapping.
//
// buildReconcileLoop wires a JsonLogger + an env-selected ReconcileEventSink into
// createReconcileLoop's onError hook via the exported handleReconcileError. This test
// drives that mapping directly with a CaptureReconcileSink (no docker, no network):
//   - phase "reap"     -> kind "reap_failure"
//   - phase "runaway"  -> kind "runaway_quarantine"
//   - phase "capacity" -> kind "capacity_defer"
// and asserts NO recorded event carries any secret-looking field (only the typed
// non-secret reconcile fields: phase / message / containerId / resourceId / ts / kind).
import { describe, it, expect } from "vitest";
import { JsonLogger, CaptureJsonSink, CaptureReconcileSink } from "@utter/observability";
import { handleReconcileError } from "../src/server";
import type { ReconcileErrorEvent } from "../src/reconcile";

function newLogger(): JsonLogger {
  return new JsonLogger(new CaptureJsonSink());
}

describe("buildReconcileLoop onError -> alert mapping", () => {
  it("maps reap -> reap_failure", () => {
    const sink = new CaptureReconcileSink();
    const e: ReconcileErrorEvent = {
      phase: "reap",
      containerId: "c-1",
      resourceId: "0xres",
      message: "stop+remove failed",
    };
    handleReconcileError(e, newLogger(), sink);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.kind).toBe("reap_failure");
    expect(sink.events[0]!.phase).toBe("reap");
    expect(typeof sink.events[0]!.ts).toBe("number");
  });

  it("maps runaway -> runaway_quarantine", () => {
    const sink = new CaptureReconcileSink();
    handleReconcileError(
      { phase: "runaway", containerId: "c-2", resourceId: "0xres", message: "restart loop" },
      newLogger(),
      sink,
    );
    expect(sink.events[0]!.kind).toBe("runaway_quarantine");
  });

  it("maps capacity -> capacity_defer", () => {
    const sink = new CaptureReconcileSink();
    handleReconcileError(
      { phase: "capacity", message: "host cap reached" },
      newLogger(),
      sink,
    );
    expect(sink.events[0]!.kind).toBe("capacity_defer");
  });

  it("maps deploy-timeout -> deploy_timeout (stale-deploying quarantine)", () => {
    const sink = new CaptureReconcileSink();
    handleReconcileError(
      { phase: "deploy-timeout", resourceId: "0xres", message: "deploying record stale" },
      newLogger(),
      sink,
    );
    expect(sink.events[0]!.kind).toBe("deploy_timeout");
    expect(sink.events[0]!.phase).toBe("deploy-timeout");
  });

  it("records NO secret-looking field: only phase/message/containerId/resourceId/ts/kind", () => {
    const sink = new CaptureReconcileSink();
    for (const e of [
      { phase: "reap", containerId: "c-1", resourceId: "0xres", message: "m" } as ReconcileErrorEvent,
      { phase: "runaway", containerId: "c-2", resourceId: "0xres", message: "m" } as ReconcileErrorEvent,
      { phase: "capacity", message: "m" } as ReconcileErrorEvent,
    ]) {
      handleReconcileError(e, newLogger(), sink);
    }

    const allowed = new Set(["kind", "phase", "message", "containerId", "resourceId", "ts"]);
    const forbidden = /secret|token|key|signature|authorization|bearer|password|credential/i;
    for (const ev of sink.events) {
      // Only the allowed keys are present (no extra field leaked in).
      for (const k of Object.keys(ev)) {
        expect(allowed.has(k)).toBe(true);
      }
      // No value looks like a secret/credential.
      expect(forbidden.test(JSON.stringify(ev))).toBe(false);
    }
  });

  it("never throws back into the loop even if the sink throws (inline-in-tick safety)", () => {
    const throwingSink = {
      emit(): void {
        throw new Error("sink exploded");
      },
    };
    // handleReconcileError wraps its whole body in try/catch.
    expect(() =>
      handleReconcileError(
        { phase: "reap", message: "m" },
        newLogger(),
        throwingSink,
      ),
    ).not.toThrow();
  });
});
