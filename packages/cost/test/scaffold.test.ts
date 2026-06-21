// Scaffold smoke test for @utter/cost (Wave 0). Asserts the member resolves and
// that a known @utter/observability runtime symbol is importable through the
// member graph (cost/call + cost/resource metrics surface through the Phase 6
// Registry). The SCL-06 feature plan replaces this with real CostAttributor /
// priceFloor tests. Import-only: no network, chain, or model path is touched.
import { describe, it, expect } from "vitest";
import { Registry, UsdcGauge } from "@utter/observability";
import * as cost from "../src/index";

describe("@utter/cost scaffold", () => {
  it("imports the member barrel", () => {
    expect(cost).toBeDefined();
  });

  it("resolves @utter/observability through the member graph", () => {
    // Registry + UsdcGauge are the surfaces the CostAttributor emits cost
    // metrics through; UsdcGauge holds 6-dp base units, gas stays native 18-dp.
    expect(typeof Registry).toBe("function");
    expect(typeof UsdcGauge).toBe("function");
  });
});
