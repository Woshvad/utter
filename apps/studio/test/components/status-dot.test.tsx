// StatusDot encodes resource/build state by the Bauhaus shape system PLUS triad
// color, so meaning is NEVER carried by color alone (WCAG / brief §13). The shape
// must be present in the DOM (a data-shape attribute) so a colorblind / SR user
// can read the state. circle = live/identity, square = resource/block/verifying,
// triangle = action/run/failed.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusDot } from "../../app/components/primitives/StatusDot";

describe("StatusDot", () => {
  it("renders state 'live' as a circle with the red token", () => {
    render(<StatusDot state="live" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("data-shape", "circle");
    expect(dot).toHaveAttribute("data-color", "red");
  });

  it("renders state 'building' as a square with the blue token", () => {
    render(<StatusDot state="building" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("data-shape", "square");
    expect(dot).toHaveAttribute("data-color", "blue");
  });

  it("renders state 'verifying' as a square with the blue token", () => {
    render(<StatusDot state="verifying" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("data-shape", "square");
    expect(dot).toHaveAttribute("data-color", "blue");
  });

  it("renders state 'failed' as a triangle with the red token", () => {
    render(<StatusDot state="failed" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("data-shape", "triangle");
    expect(dot).toHaveAttribute("data-color", "red");
  });

  it("renders state 'paused' as a square with the yellow token", () => {
    render(<StatusDot state="paused" />);
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("data-shape", "square");
    expect(dot).toHaveAttribute("data-color", "yellow");
  });

  it("exposes an accessible text label so the state is screen-reader legible", () => {
    render(<StatusDot state="live" />);
    // the label text is present (not color-only)
    expect(screen.getByText(/live/i)).toBeInTheDocument();
  });

  it("carries the shape on the badge primitives too (ReputationBadge renders its number)", async () => {
    const { ReputationBadge } = await import("../../app/components/primitives/ReputationBadge");
    render(<ReputationBadge feedbackCount={12n} />);
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it("BondBadge renders its mono bonded amount from base units", async () => {
    const { BondBadge } = await import("../../app/components/primitives/BondBadge");
    render(<BondBadge bond={5000000n} decimals={6} />);
    expect(screen.getByText(/\$5\.000000/)).toBeInTheDocument();
  });
});
