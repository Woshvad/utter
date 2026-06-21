// SCL-06: the cost gauges added to the OBS-01 registry. cost/call and
// cost/resource are 6dp USDC base-unit gauges, rendered decimals-aware from a
// runtime decimals (no literal) - the same discipline as the other USDC gauges.
// Native-18dp relayer gas is NOT a USDC gauge here; it stays in the CostAttributor
// gas lane (Pitfall 5).
import { describe, it, expect } from "vitest";
import { Registry, OBS_METRIC_NAMES } from "../src/registry";

describe("SCL-06 cost gauges in the registry", () => {
  it("registers cost_call_usdc and cost_resource_usdc in OBS_METRIC_NAMES", () => {
    expect(OBS_METRIC_NAMES).toContain("cost_call_usdc");
    expect(OBS_METRIC_NAMES).toContain("cost_resource_usdc");
  });

  it("holds 6dp base units and renders them decimals-aware from a runtime decimals", () => {
    const registry = new Registry();
    registry.costCallUsdc.set(4_600n); // 0.0046 USDC base units
    registry.costResourceUsdc.set(4_600n);
    expect(registry.costCallUsdc.baseUnits).toBe(4_600n);
    const rendered = registry.render(6);
    expect(rendered).toContain("cost_call_usdc 0.0046");
    expect(rendered).toContain("cost_resource_usdc 0.0046");
  });

  it("defaults cost gauges to zero base units", () => {
    const registry = new Registry();
    expect(registry.costCallUsdc.baseUnits).toBe(0n);
    expect(registry.costResourceUsdc.baseUnits).toBe(0n);
  });
});
