// build-stream.test.tsx - the streamed-error render test for BuildStream.
//
// BuildStream opens an injectable EventSource on the SSE route and applies each `stage`
// BuildEvent to the per-stage BuildStepBlock states. This test proves a streamed
// Generate:error event renders its reason text visibly (red) so the operator is never
// blind when real generation fails - the failure must not look like a stuck stream.
//
// It uses the eventSourceFactory injection seam: a fake EventSourceLike captures the
// "stage" listener, then we dispatch a Generate error event through it wrapped in act().
import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import {
  BuildStream,
  type EventSourceLike,
} from "../../app/components/build/BuildStream";

/** A fake EventSource that captures the "stage" AND "error" listeners so the test can
 *  drive both synchronously (no real network, no real EventSource). */
class FakeEventSource implements EventSourceLike {
  stageListener?: (ev: { data: string }) => void;
  errorListener?: (ev: { data: string }) => void;
  closed = false;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    if (type === "stage") this.stageListener = listener;
    if (type === "error") this.errorListener = listener;
  }
  close(): void {
    this.closed = true;
  }
}

describe("BuildStream streamed error render", () => {
  it("renders a streamed Generate:error stage reason (red failed row)", () => {
    const es = new FakeEventSource();
    render(
      <BuildStream
        eventsUrl="/resources/0xabc/events"
        eventSourceFactory={() => es}
      />,
    );

    // Dispatch a real Generate error event through the captured listener (wrapped in act
    // so React flushes the state update), exactly as the SSE route would deliver it.
    const reason = "bundle failed validation (g1/forced: nope)";
    act(() => {
      es.stageListener?.({
        data: JSON.stringify({ stage: "Generate", status: "error", log: reason }),
      });
    });

    // The Generate row is in the failed state and shows the streamed reason text (red).
    const generate = screen
      .getAllByTestId("build-step-block")
      .find((el) => el.getAttribute("data-stage") === "Generate");
    expect(generate).toBeDefined();
    expect(generate).toHaveAttribute("data-status", "failed");
    expect(generate).toHaveAttribute("data-color", "red");
    // BuildStepBlock renders the failed-reason line as "generate failed: <reason>." in red.
    // The reason also appears in the plain log line, so target the unique failed-reason
    // phrasing to assert the streamed reason renders visibly.
    expect(
      screen.getByText(/generate failed: bundle failed validation/i),
    ).toBeInTheDocument();
  });

  it("shows an interruption banner + retry when the stream drops BEFORE settling (429/503)", () => {
    // EventSource surfaces the new pre-stream 429/503 admission denials as a bare
    // `error` with no body. Without the banner the six blocks freeze at "pending"
    // forever; the banner makes the interruption visible and offers a reconnect.
    const es = new FakeEventSource();
    render(
      <BuildStream eventsUrl="/resources/0xabc/events" eventSourceFactory={() => es} />,
    );
    act(() => {
      es.errorListener?.({ data: "" });
    });
    expect(screen.getByTestId("build-interrupted")).toBeInTheDocument();
    expect(screen.getByTestId("build-retry")).toBeInTheDocument();
  });

  it("does NOT show the interruption banner when the stream closes AFTER settling", () => {
    // A clean server close after Live:ok also fires `error`; that must NOT read as an
    // interruption. Same for a settled stage error (already shown as a failed row).
    const es = new FakeEventSource();
    render(
      <BuildStream eventsUrl="/resources/0xabc/events" eventSourceFactory={() => es} />,
    );
    act(() => {
      // Walk to the live moment, then the server closes the stream (error fires).
      for (const stage of ["Generate", "Deploy", "Verify", "Mint", "Publish", "Live"]) {
        es.stageListener?.({
          data: JSON.stringify({ stage, status: "ok", log: "" }),
        });
      }
    });
    act(() => {
      es.errorListener?.({ data: "" });
    });
    expect(screen.queryByTestId("build-interrupted")).not.toBeInTheDocument();
  });

  it("shows an overall progress bar that advances per stage (half-credit for the in-flight stage)", () => {
    const es = new FakeEventSource();
    render(
      <BuildStream eventsUrl="/resources/0xabc/events" eventSourceFactory={() => es} />,
    );
    act(() => {
      es.stageListener?.({ data: JSON.stringify({ stage: "Generate", status: "ok", log: "" }) });
      es.stageListener?.({ data: JSON.stringify({ stage: "Deploy", status: "running", log: "" }) });
    });
    // 1 done + 0.5 in-flight, of 6 stages = 25%; the fill pulses (blue) while running.
    const fill = screen.getByTestId("build-progress-fill");
    expect(fill.getAttribute("data-pct")).toBe("25");
    expect(fill.className).toContain("bg-blue");
    expect(fill.className).toContain("animate-utter-pulse");
    const label = screen.getByTestId("build-progress-label").textContent ?? "";
    expect(label).toContain("step 2 of 6");
    expect(label).toContain("deploy");
  });

  it("turns the progress bar red and reports where it halted on a stage failure", () => {
    const es = new FakeEventSource();
    render(
      <BuildStream eventsUrl="/resources/0xabc/events" eventSourceFactory={() => es} />,
    );
    act(() => {
      es.stageListener?.({ data: JSON.stringify({ stage: "Generate", status: "ok", log: "" }) });
      es.stageListener?.({ data: JSON.stringify({ stage: "Deploy", status: "error", log: "boom" }) });
    });
    const fill = screen.getByTestId("build-progress-fill");
    expect(fill.className).toContain("bg-red");
    expect(fill.className).not.toContain("animate-utter-pulse");
    expect(screen.getByTestId("build-progress-label").textContent).toContain("stopped at deploy");
  });
});
