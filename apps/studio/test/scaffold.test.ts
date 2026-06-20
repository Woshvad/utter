// Scaffold smoke test for @utter/studio (Wave 0). Asserts the member resolves and
// that a known @utter/chain symbol is importable through the member graph,
// mirroring the marketplace scaffold test. The feature waves replace this with
// real route/component tests.
import { describe, it, expect } from "vitest";
import { RESOURCE_REGISTRY } from "@utter/chain";
import { selectAdapter } from "../app/adapter/select";

describe("@utter/studio scaffold", () => {
  it("resolves @utter/chain through the member graph", () => {
    expect(RESOURCE_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("exposes the adapter seam barrel", () => {
    expect(selectAdapter).toBeTypeOf("function");
  });
});
