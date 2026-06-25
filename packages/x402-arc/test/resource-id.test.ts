// resourceIdForLabel suite. Proves the shared label-to-resourceId helper is
// deterministic (keccak256(toHex(label))), pins the echo id so the deployer
// refactor cannot move it, and that a blank label fails loud. Offline unit test.
import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import { resourceIdForLabel, ECHO_RESOURCE_LABEL } from "../src/resource-id";

describe("resourceIdForLabel", () => {
  it("is deterministic: equals keccak256(toHex(label))", () => {
    for (const label of ["utter:echo:live-deploy", "utter:weather:nyc"]) {
      expect(resourceIdForLabel(label)).toBe(keccak256(toHex(label)));
    }
  });

  it("pins the echo id so the single-source-of-truth refactor did not move it", () => {
    // The exact id the deployer used before, computed inline from the same label.
    expect(resourceIdForLabel(ECHO_RESOURCE_LABEL)).toBe(
      keccak256(toHex("utter:echo:live-deploy")),
    );
    expect(ECHO_RESOURCE_LABEL).toBe("utter:echo:live-deploy");
  });

  it("throws on an empty or blank label", () => {
    expect(() => resourceIdForLabel("")).toThrow();
    expect(() => resourceIdForLabel("   ")).toThrow();
  });
});
