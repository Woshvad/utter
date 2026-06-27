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

/** A fake EventSource that captures the "stage" listener so the test can dispatch a
 *  BuildEvent into the component synchronously (no real network, no real EventSource). */
class FakeEventSource implements EventSourceLike {
  stageListener?: (ev: { data: string }) => void;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    if (type === "stage") this.stageListener = listener;
  }
  close(): void {}
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
});
