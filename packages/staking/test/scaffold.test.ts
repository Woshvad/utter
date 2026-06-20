// Scaffold smoke test for @utter/staking (Wave 0). Asserts the member resolves
// and that a known @utter/chain symbol is importable through the member graph,
// mirroring the 03-01 scaffold test. The feature waves replace this with real
// bond/takedown client tests.
import { describe, it, expect } from "vitest";
import { STAKING_VAULT, stakingVaultAbi } from "@utter/chain";
import * as staking from "../src/index";

describe("@utter/staking scaffold", () => {
  it("imports the member barrel", () => {
    expect(staking).toBeDefined();
  });

  it("resolves @utter/chain (incl. the new stakingVaultAbi) through the member graph", () => {
    expect(STAKING_VAULT).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(stakingVaultAbi.some((e) => e.type === "function" && e.name === "slash")).toBe(true);
  });
});
