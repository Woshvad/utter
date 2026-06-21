// Scaffold smoke test for @utter/orchestrator (Wave 0). Asserts the member
// resolves and that a known @utter/sandbox runtime symbol is importable through
// the member graph (the orchestrator schedules the Phase 3 SandboxRunner). The
// SCL-01 feature plan replaces this with real placement/warm-pool/reaper tests.
// Import-only: no network, chain, or isolation host is touched.
import { describe, it, expect } from "vitest";
import { createInMemoryStores } from "@utter/sandbox";
import * as orchestrator from "../src/index";

describe("@utter/orchestrator scaffold", () => {
  it("imports the member barrel", () => {
    expect(orchestrator).toBeDefined();
  });

  it("resolves @utter/sandbox through the member graph", () => {
    // createInMemoryStores is a known @utter/sandbox runtime export; the
    // orchestrator schedules the SandboxRunner workload, never re-implements it.
    expect(typeof createInMemoryStores).toBe("function");
  });
});
