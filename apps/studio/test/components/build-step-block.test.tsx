// BuildStepBlock renders one square step of the deploy pipeline (consumed by Plan
// 04's BuildStream). These tests pin all five visual states with shape + color so
// meaning is never color-only, and the plain failure reason on failure. BauhausChart
// is also covered: flat triad bars with both axes, no per-bar labels, no gradient/3D.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BuildStepBlock } from "../../app/components/build/BuildStepBlock";
import { BauhausChart } from "../../app/components/charts/BauhausChart";

describe("BuildStepBlock", () => {
  it("pending: renders an ink-outline square", () => {
    render(<BuildStepBlock stage="Generate" status="pending" />);
    const block = screen.getByTestId("build-step-block");
    expect(block).toHaveAttribute("data-status", "pending");
    expect(block).toHaveAttribute("data-shape", "square");
  });

  it("active: renders a pulsing square", () => {
    render(<BuildStepBlock stage="Deploy" status="active" />);
    const block = screen.getByTestId("build-step-block");
    expect(block).toHaveAttribute("data-status", "active");
    expect(block).toHaveAttribute("data-shape", "square");
  });

  it("verifying: renders a blue pulsing square", () => {
    render(<BuildStepBlock stage="Verify" status="verifying" />);
    const block = screen.getByTestId("build-step-block");
    expect(block).toHaveAttribute("data-status", "verifying");
    expect(block).toHaveAttribute("data-color", "blue");
  });

  it("done: renders a filled block", () => {
    render(<BuildStepBlock stage="Mint" status="done" />);
    const block = screen.getByTestId("build-step-block");
    expect(block).toHaveAttribute("data-status", "done");
  });

  it("failed: renders a red triangle + the plain failure reason text", () => {
    render(
      <BuildStepBlock
        stage="Verify"
        status="failed"
        reason="response did not match openapi schema"
      />,
    );
    const block = screen.getByTestId("build-step-block");
    expect(block).toHaveAttribute("data-status", "failed");
    expect(block).toHaveAttribute("data-shape", "triangle");
    expect(block).toHaveAttribute("data-color", "red");
    expect(screen.getByText(/response did not match openapi schema/i)).toBeInTheDocument();
  });

  it("announces the stage to screen readers via a status role", () => {
    render(<BuildStepBlock stage="Generate" status="active" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("BauhausChart", () => {
  it("renders one flat bar per data point (no per-bar labels, per the comp)", () => {
    render(
      <BauhausChart
        series={[
          { label: "mon", value: 3 },
          { label: "tue", value: 7 },
          { label: "wed", value: 5 },
        ]}
        color="yellow"
        ariaLabel="revenue per day"
      />,
    );
    const chart = screen.getByTestId("bauhaus-chart");
    expect(within(chart).getAllByTestId("chart-bar")).toHaveLength(3);
    // The comp draws no per-bar x-axis text labels; the chart renders bars only.
    expect(within(chart).queryByText("mon")).toBeNull();
    expect(chart).toHaveAttribute("data-color", "yellow");
  });

  it("uses the triad color token for the series", () => {
    render(
      <BauhausChart
        series={[{ label: "a", value: 1 }]}
        color="blue"
        ariaLabel="calls"
      />,
    );
    expect(screen.getByTestId("bauhaus-chart")).toHaveAttribute("data-color", "blue");
  });

  it("renders an empty chart gracefully", () => {
    render(<BauhausChart series={[]} color="red" ariaLabel="health" />);
    expect(screen.getByTestId("bauhaus-chart")).toBeInTheDocument();
  });
});
