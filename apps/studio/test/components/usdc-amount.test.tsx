// UsdcAmount is the single money-render surface for the whole Studio. These tests
// pin the non-negotiable money discipline (CLAUDE.md / SPEC §2): a USDC amount is
// rendered exactly, mono, 6dp-aware, and formatted ONLY from a passed-in `decimals`
// prop sourced from a runtime read - never a 1e6/6/18 literal in the format math.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UsdcAmount } from "../../app/components/primitives/UsdcAmount";

describe("UsdcAmount", () => {
  it("renders 12345 base units at decimals=6 as $0.012345", () => {
    render(<UsdcAmount baseUnits={12345n} decimals={6} />);
    expect(screen.getByText("$0.012345")).toBeInTheDocument();
  });

  it("renders 1_000_000 base units at decimals=6 as $1 (trailing zeros trimmed)", () => {
    render(<UsdcAmount baseUnits={1000000n} decimals={6} />);
    expect(screen.getByText("$1")).toBeInTheDocument();
  });

  it("renders 0 base units at decimals=6 as $0 (trailing zeros trimmed)", () => {
    render(<UsdcAmount baseUnits={0n} decimals={6} />);
    expect(screen.getByText("$0")).toBeInTheDocument();
  });

  it("formats from the decimals prop, not a hardcoded scale (decimals=2)", () => {
    render(<UsdcAmount baseUnits={12345n} decimals={2} />);
    expect(screen.getByText("$123.45")).toBeInTheDocument();
  });

  it("renders mono tabular-nums so columns of money align", () => {
    render(<UsdcAmount baseUnits={1000000n} decimals={6} />);
    const el = screen.getByText("$1");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("tabular-nums");
  });

  it("contains zero money literal (no 1e6 / 10**6 / / 1000000 / bare 6|18) in the format math", () => {
    // Resolve relative to THIS test file so the path holds whether run under the
    // package-local config (cwd = apps/studio) or the root projects runner (cwd =
    // repo root). import.meta.dirname is the test file's directory.
    const src = readFileSync(
      resolve(import.meta.dirname, "../../app/components/primitives/UsdcAmount.tsx"),
      "utf8",
    );
    // strip comments so doc-prose mentioning "6dp" does not trip the grep
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/1e6/);
    expect(code).not.toMatch(/10\s*\*\*\s*6/);
    expect(code).not.toMatch(/\/\s*1000000/);
    expect(code).not.toMatch(/1_000_000/);
    // the only decimals reference allowed is the prop; no bare 6n / 18n exponent literal
    expect(code).not.toMatch(/\bBigInt\(\s*6\s*\)/);
    expect(code).not.toMatch(/\b6n\b/);
    expect(code).not.toMatch(/\b18n\b/);
  });
});
