// Scaffold smoke test for @utter/ai-scorer (Wave 0). Asserts the member resolves
// and that a known @utter/chain symbol is importable through the member graph,
// mirroring the 03-01 scaffold test. The feature waves replace this with real
// scorer/moderation tests.
import { describe, it, expect } from "vitest";
import { STAKING_VAULT } from "@utter/chain";
import * as aiScorer from "../src/index";

describe("@utter/ai-scorer scaffold", () => {
  it("imports the member barrel", () => {
    expect(aiScorer).toBeDefined();
  });

  it("resolves @utter/chain through the member graph", () => {
    expect(STAKING_VAULT).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
