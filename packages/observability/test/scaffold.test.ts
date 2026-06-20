// Scaffold smoke test for @utter/observability (Wave 0). Asserts the member
// resolves and that a known @utter/chain symbol is importable through the member
// graph (the runtime-decimals read on USDC gauges will use @utter/chain). The OBS
// feature plans replace this with real registry/logger/alert tests.
import { describe, it, expect } from "vitest";
import { RESOURCE_REGISTRY } from "@utter/chain";
import * as observability from "../src/index";

describe("@utter/observability scaffold", () => {
  it("imports the member barrel", () => {
    expect(observability).toBeDefined();
  });

  it("resolves @utter/chain through the member graph", () => {
    expect(RESOURCE_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
