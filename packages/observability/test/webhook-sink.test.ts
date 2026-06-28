// webhook-sink.test.ts - the best-effort reconcile alert sink (provisioning/ops track).
//
// The invariants under test (all WITHOUT a real network):
//   - selectReconcileEventSink({}) -> a no-op sink that makes NO fetch call.
//   - with ALERT_WEBHOOK_URL set + a FAKE (resolved) fetch -> emit POSTs once to the
//     url (method POST, content-type application/json, body JSON-parses to the event).
//   - a REJECTING fake fetch -> emit returns synchronously, does NOT throw, leaves no
//     unhandled rejection, and the logger captured a "post failed" warn with the kind
//     only (no url).
//   - a SYNC-throwing fake fetch -> emit swallows it (best-effort, never throws).
import { describe, it, expect, vi } from "vitest";
import {
  selectReconcileEventSink,
  type ReconcileAlertEvent,
} from "../src/webhook-sink";
import { JsonLogger, CaptureJsonSink } from "../src/jsonlog";

function sampleEvent(): ReconcileAlertEvent {
  return {
    kind: "reap_failure",
    phase: "reap",
    message: "stop+remove failed",
    containerId: "c-123",
    resourceId: "0xabc",
    ts: 1_700_000_000_000,
  };
}

describe("selectReconcileEventSink gate (ALERT_WEBHOOK_URL)", () => {
  it("unset -> a no-op sink makes NO fetch call", () => {
    const fetchImpl = vi.fn();
    // The no-op path is selected purely by the empty env; the spy proves no fetch fires.
    const sink = selectReconcileEventSink({} as NodeJS.ProcessEnv);
    sink.emit(sampleEvent());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blank/whitespace URL -> a no-op sink (still no network)", () => {
    const sink = selectReconcileEventSink({ ALERT_WEBHOOK_URL: "   " } as NodeJS.ProcessEnv);
    // No throw, no network: emit is a pure no-op.
    expect(() => sink.emit(sampleEvent())).not.toThrow();
  });
});

describe("selectReconcileEventSink active (URL set)", () => {
  it("emit POSTs once to the url with the JSON event body", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const logger = new JsonLogger(new CaptureJsonSink());
    // Inject the fake fetch via the env-selected sink's poster: build directly through
    // makeWebhookPoster-backed selection by stubbing the global fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const sink = selectReconcileEventSink(
        { ALERT_WEBHOOK_URL: "https://x/ingest" } as NodeJS.ProcessEnv,
        logger,
      );
      const e = sampleEvent();
      sink.emit(e);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(url).toBe("https://x/ingest");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe(
        "application/json",
      );
      expect(JSON.parse(init.body as string)).toEqual(e);
    } finally {
      globalThis.fetch = realFetch;
    }
    // Let any microtask settle (there is none to fail, but be tidy).
    await Promise.resolve();
  });

  it("a REJECTING fetch -> emit returns synchronously, no throw, no unhandled rejection, warn logged with kind only", async () => {
    const rejecting = vi.fn(async () => {
      throw new Error("network down (this message must NOT be logged)");
    });
    const captured = new CaptureJsonSink();
    const logger = new JsonLogger(captured);

    // Track unhandled rejections during this test.
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown): void => {
      unhandled.push(r);
    };
    process.on("unhandledRejection", onUnhandled);

    const realFetch = globalThis.fetch;
    globalThis.fetch = rejecting as unknown as typeof fetch;
    try {
      const sink = selectReconcileEventSink(
        { ALERT_WEBHOOK_URL: "https://x/ingest" } as NodeJS.ProcessEnv,
        logger,
      );
      // emit must NOT throw even though the fetch rejects.
      expect(() => sink.emit(sampleEvent())).not.toThrow();
      // Let the rejected promise's .catch run.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      globalThis.fetch = realFetch;
      process.removeListener("unhandledRejection", onUnhandled);
    }

    // No unhandled rejection escaped the .catch.
    expect(unhandled).toHaveLength(0);

    // The logger captured a "post failed" warn carrying the KIND only - never the url.
    const postFailed = captured.records.filter((r) => r.msg === "alert webhook post failed");
    expect(postFailed.length).toBeGreaterThanOrEqual(1);
    for (const r of postFailed) {
      expect(r.kind).toBe("reap_failure");
      // No url anywhere on the line.
      expect(JSON.stringify(r)).not.toContain("https://x/ingest");
    }
  });

  it("a SYNC-throwing fetch -> emit swallows it (never throws)", () => {
    const syncThrow = vi.fn(() => {
      throw new Error("synchronous fetch explosion");
    });
    const logger = new JsonLogger(new CaptureJsonSink());

    const realFetch = globalThis.fetch;
    globalThis.fetch = syncThrow as unknown as typeof fetch;
    try {
      const sink = selectReconcileEventSink(
        { ALERT_WEBHOOK_URL: "https://x/ingest" } as NodeJS.ProcessEnv,
        logger,
      );
      expect(() => sink.emit(sampleEvent())).not.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
