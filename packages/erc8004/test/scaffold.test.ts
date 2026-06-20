// Scaffold smoke test for @utter/erc8004 (Wave 0). Asserts the member resolves
// and that a known @utter/chain symbol is importable through the member graph,
// mirroring the 03-01 scaffold test. The feature waves replace this with real
// identity-client tests.
import { describe, it, expect } from "vitest";
import { STAKING_VAULT } from "@utter/chain";
import * as erc8004 from "../src/index";

describe("@utter/erc8004 scaffold", () => {
  it("imports the member barrel", () => {
    expect(erc8004).toBeDefined();
  });

  it("resolves @utter/chain through the member graph", () => {
    expect(STAKING_VAULT).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
