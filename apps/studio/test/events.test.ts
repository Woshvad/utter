// events.test.ts - STU-02 SSE build-stream route + BuildStream tests.
//
// Covers: (1) the resource route streams the six pipeline stages as
// `event: stage` text/event-stream frames and terminates cleanly; (2) an abort
// mid-stream closes the stream with no hang (T-06-SSE-LEAK / Pitfall 4); (3) a bad
// param is rejected before the adapter (T-06-PARAM); (4) BuildStream applies each
// streamed event to the stage blocks and announces it to the SR live-region.
import { describe, it, expect, vi } from "vitest";
import { loader } from "../app/routes/resources.$id.events";
import { applyStage } from "../app/components/build/BuildStream";
import { BUILD_STAGES, type BuildEvent } from "../app/adapter/types";

/** Drain a ReadableStream<Uint8Array> to a decoded string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

/** Parse SSE `event:`/`data:` frames into typed records. */
function parseFrames(raw: string): { event: string; data: BuildEvent }[] {
  return raw
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))!.slice("event:".length).trim();
      const data = lines.find((l) => l.startsWith("data:"))!.slice("data:".length).trim();
      return { event, data: JSON.parse(data) as BuildEvent };
    });
}

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

describe("resources.$id.events SSE route", () => {
  it("streams the six pipeline stages as text/event-stream frames and terminates", async () => {
    const req = new Request(`http://localhost/resources/${ID}/events`);
    const res = await loader({ params: { id: ID }, request: req, context: {} } as never);

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.body).toBeTruthy();

    const raw = await drain(res.body as ReadableStream<Uint8Array>);
    const frames = parseFrames(raw);

    // every frame is an `event: stage` frame
    expect(frames.every((f) => f.event === "stage")).toBe(true);

    // the six stages all appear, in canonical order, ending Live -> ok
    const stages = frames.map((f) => f.data.stage);
    for (const stage of BUILD_STAGES) expect(stages).toContain(stage);
    const last = frames[frames.length - 1]!;
    expect(last.data.stage).toBe("Live");
    expect(last.data.status).toBe("ok");
  });

  it("closes the stream cleanly when request.signal aborts mid-stream (no hang)", async () => {
    const controller = new AbortController();
    const req = new Request(`http://localhost/resources/${ID}/events`, {
      signal: controller.signal,
    });
    const res = await loader({ params: { id: ID }, request: req, context: {} } as never);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    // read one chunk, then abort - the stream must terminate, not hang.
    await reader.read();
    controller.abort();

    // draining the rest must settle (done:true) - if the generator leaked this hangs
    // and the test's own timeout (30s hookTimeout) would trip.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(controller.signal.aborted).toBe(true);
  });

  it("rejects a malformed param before reaching the adapter (T-06-PARAM)", async () => {
    const bad = "../../etc/passwd";
    const req = new Request("http://localhost/resources/x/events");
    const res = await loader({ params: { id: bad }, request: req, context: {} } as never);
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("BuildStream applyStage", () => {
  it("maps a running Generate event to the active block state", () => {
    const init = Object.fromEntries(BUILD_STAGES.map((s) => [s, { status: "pending" }]));
    const ev: BuildEvent = { stage: "Generate", status: "running", log: "generating" };
    const next = applyStage(init as never, ev);
    expect(next.Generate.status).toBe("active");
    expect(next.Generate.log).toBe("generating");
  });

  it("maps a running Verify event to the blue verifying state (the gate beat)", () => {
    const init = Object.fromEntries(BUILD_STAGES.map((s) => [s, { status: "pending" }]));
    const ev: BuildEvent = { stage: "Verify", status: "running", log: "probing" };
    const next = applyStage(init as never, ev);
    expect(next.Verify.status).toBe("verifying");
  });

  it("maps an ok Live event to the done state, and an error to failed", () => {
    const init = Object.fromEntries(BUILD_STAGES.map((s) => [s, { status: "pending" }]));
    const live = applyStage(init as never, { stage: "Live", status: "ok", log: "live" });
    expect(live.Live.status).toBe("done");
    const fail = applyStage(init as never, {
      stage: "Deploy",
      status: "error",
      log: "sandbox refused",
    });
    expect(fail.Deploy.status).toBe("failed");
    expect(fail.Deploy.reason).toBe("sandbox refused");
  });
});

describe("BuildStream component", () => {
  it("applies streamed events to the blocks and announces each to the SR live-region", async () => {
    const { render, screen, waitFor } = await import("@testing-library/react");
    const React = await import("react");
    const { BuildStream } = await import("../app/components/build/BuildStream");

    // a fake EventSource that the test drives synchronously.
    type Listener = (e: { data: string }) => void;
    const listeners: Record<string, Listener[]> = {};
    const fakeEs = {
      addEventListener: (type: string, fn: Listener) => {
        (listeners[type] ??= []).push(fn);
      },
      close: vi.fn(),
    };
    const emit = (ev: BuildEvent) =>
      listeners.stage?.forEach((fn) => fn({ data: JSON.stringify(ev) }));

    render(
      React.createElement(BuildStream, {
        eventsUrl: `/resources/${ID}/events`,
        eventSourceFactory: () => fakeEs,
      }),
    );

    // stream all six stages to "ok"
    const { act } = await import("@testing-library/react");
    for (const stage of BUILD_STAGES) {
      act(() => emit({ stage, status: "ok", log: `${stage} ok` }));
    }

    // the SR live-region announced the last stage; the live moment is rendered
    await waitFor(() => {
      expect(screen.getByTestId("build-stream-live").textContent).toContain("live");
    });
    expect(screen.getByTestId("build-live-moment")).toBeInTheDocument();

    // the iterate bar is a real GET form targeting /create with a prompt input, so
    // refining re-utters via /create?prompt=<text> (not a static span).
    const iterate = screen.getByTestId("build-iterate") as HTMLFormElement;
    expect(iterate.tagName).toBe("FORM");
    expect(iterate.getAttribute("method")).toBe("get");
    expect(iterate.getAttribute("action")).toBe("/create");
    const refine = screen.getByLabelText("refine prompt") as HTMLInputElement;
    expect(refine.getAttribute("name")).toBe("prompt");
  });
});
