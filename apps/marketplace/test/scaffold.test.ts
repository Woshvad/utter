// Scaffold smoke test for @utter/marketplace (Wave 0). Asserts the member resolves
// and that a known @utter/chain symbol is importable through the member graph,
// mirroring the 03-01 scaffold test. The feature waves replace this with real
// listing/agent-card tests.
import { describe, it, expect } from "vitest";
import { RESOURCE_REGISTRY } from "@utter/chain";
import * as marketplace from "../src/index";

describe("@utter/marketplace scaffold", () => {
  it("imports the member barrel", () => {
    expect(marketplace).toBeDefined();
  });

  it("resolves @utter/chain through the member graph", () => {
    expect(RESOURCE_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
