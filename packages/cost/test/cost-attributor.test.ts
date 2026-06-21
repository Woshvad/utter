// SCL-06 CostAttributor tests. The load-bearing rule (08-RESEARCH Pitfall 5):
// relayer gas is native 18-dp and USDC revenue is 6-dp; they live in STRICTLY
// separate bigint lanes - never a single bigint sums a gas value and a USDC value.
// The USDC components (hosting + data-proxy markup + model-call cost) sum in a 6dp
// lane; gas stays in its own native-18dp field. Conversion to a unified figure
// happens only at a clearly-labeled boundary with an injected runtime decimals()
// read - no 6 / 1e6 / 10**6 literal in the money path.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CostAttributor } from "../src/cost-attributor";
import { Registry } from "@utter/observability";

// Base-unit fixtures (deterministic; no live chain - Pitfall 8). USDC components
// are 6dp base units; gas is native 18dp.
const HOSTING_6DP = 1_500n; // 0.0015 USDC amortized warm-pool/compute time
const PROXY_MARKUP_6DP = 800n; // 0.0008 USDC data-proxy markup
const MODEL_6DP = 2_300n; // 0.0023 USDC model-call cost
const GAS_NATIVE_18DP = 21_000_000_000_000n; // tx gas * gasPrice, native 18dp

describe("CostAttributor.attribute", () => {
  it("sums the USDC components into a 6dp usdcCost lane", () => {
    const attributor = new CostAttributor();
    const result = attributor.attribute({
      hostingBaseUnits: HOSTING_6DP,
      gasNative18dp: GAS_NATIVE_18DP,
      proxyMarkupBaseUnits: PROXY_MARKUP_6DP,
      modelCostBaseUnits: MODEL_6DP,
    });
    // hosting + markup + model, all 6dp.
    expect(result.usdcCost).toBe(HOSTING_6DP + PROXY_MARKUP_6DP + MODEL_6DP);
  });

  it("keeps relayer gas in a SEPARATE native-18dp field, not merged into usdcCost", () => {
    const attributor = new CostAttributor();
    const result = attributor.attribute({
      hostingBaseUnits: HOSTING_6DP,
      gasNative18dp: GAS_NATIVE_18DP,
      proxyMarkupBaseUnits: PROXY_MARKUP_6DP,
      modelCostBaseUnits: MODEL_6DP,
    });
    // Distinct fields; gas is its own lane.
    expect(result.gasCostNative).toBe(GAS_NATIVE_18DP);
    // usdcCost must NOT contain the gas value (no cross-unit sum).
    expect(result.usdcCost).not.toBe(
      HOSTING_6DP + PROXY_MARKUP_6DP + MODEL_6DP + GAS_NATIVE_18DP,
    );
    // The two lanes are distinct typed fields.
    expect(typeof result.usdcCost).toBe("bigint");
    expect(typeof result.gasCostNative).toBe("bigint");
  });

  it("converts gas to a USDC-comparable figure ONLY via an injected runtime decimals reader", () => {
    const attributor = new CostAttributor();
    const result = attributor.attribute({
      hostingBaseUnits: HOSTING_6DP,
      gasNative18dp: GAS_NATIVE_18DP,
      proxyMarkupBaseUnits: PROXY_MARKUP_6DP,
      modelCostBaseUnits: MODEL_6DP,
    });
    // gasNativeDecimals=18, usdcDecimals=6 supplied by a runtime read (injected).
    // 21_000_000_000_000 / 10^(18-6) = 21 in 6dp base units.
    const unified = attributor.toUsdcComparable(result, {
      gasNativeDecimals: 18,
      usdcDecimals: 6,
    });
    // unified = usdcCost (6dp) + gas scaled down to 6dp.
    expect(unified).toBe(HOSTING_6DP + PROXY_MARKUP_6DP + MODEL_6DP + 21n);
  });

  it("emits cost/call and cost/resource to the observability registry in base units", () => {
    const attributor = new CostAttributor();
    const registry = new Registry();
    const result = attributor.attribute({
      hostingBaseUnits: HOSTING_6DP,
      gasNative18dp: GAS_NATIVE_18DP,
      proxyMarkupBaseUnits: PROXY_MARKUP_6DP,
      modelCostBaseUnits: MODEL_6DP,
    });
    attributor.emit(registry, result);
    // The cost/call gauge holds the per-call USDC base units (6dp).
    expect(registry.costCallUsdc.baseUnits).toBe(result.usdcCost);
    // The render (with runtime decimals) contains the cost metric names.
    const rendered = registry.render(6);
    expect(rendered).toContain("cost_call_usdc");
    expect(rendered).toContain("cost_resource_usdc");
  });

  it("has NO single bigint summing a gas value and a USDC value (grep-clean source)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/cost-attributor.ts", import.meta.url)),
      "utf8",
    );
    // No identifier that pairs a gas symbol additively with a usdc symbol.
    expect(/gas\w*\s*\+\s*\w*usdc/i.test(src)).toBe(false);
    expect(/usdc\w*\s*\+\s*\w*gas/i.test(src)).toBe(false);
  });

  it("has NO 6 / 1e6 / 10**6 decimals literal in the money path", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/cost-attributor.ts", import.meta.url)),
      "utf8",
    );
    expect(/\b1e6\b/.test(src)).toBe(false);
    expect(/10\s*\*\*\s*6\b/.test(src)).toBe(false);
    expect(/10n?\s*\*\*\s*6n?\b/.test(src)).toBe(false);
  });
});
