// pin-dispatcher.test.ts: unit tests for the M7 pinning factory + the H3
// allowlist-resolver helpers (the seam pieces, isolated from the proxy route).
import { describe, it, expect } from "vitest";
import {
  defaultPinningDispatcherFactory,
  globalAllowlistResolver,
  resolveResourceAllowlist,
} from "../src/index";

describe("defaultPinningDispatcherFactory", () => {
  it("returns undefined for an empty address set (nothing validated to pin to)", async () => {
    const d = await defaultPinningDispatcherFactory("api.openai.com", []);
    expect(d).toBeUndefined();
  });

  it("falls back to undefined when undici is not importable (no-pin, today's behavior)", async () => {
    // In this repo state `undici` is not a resolvable dependency of @utter/data-proxy
    // (it is only a transitive test dep of jsdom, isolated by pnpm). The factory must
    // degrade to no-pin rather than throw, so the forward proceeds with the block-set
    // rechecks still in force. When `undici` is later added as a real dependency this
    // returns a live Agent with no proxy-code change.
    const d = await defaultPinningDispatcherFactory("api.openai.com", [
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(d).toBeUndefined();
  });
});

describe("allowlist resolver helpers (H3)", () => {
  it("globalAllowlistResolver returns the same list for every resource", () => {
    const r = globalAllowlistResolver(["api.openai.com"]);
    expect(r("resource-aaaa-1111")).toEqual(["api.openai.com"]);
    expect(r("resource-bbbb-2222")).toEqual(["api.openai.com"]);
  });

  it("globalAllowlistResolver returns an empty (default-deny) list when no global list is given", () => {
    const r = globalAllowlistResolver(undefined);
    expect(r("resource-aaaa-1111")).toEqual([]);
  });

  it("resolveResourceAllowlist returns each resource's OWN list and default-denies an unmapped resource", () => {
    expect(resolveResourceAllowlist("resource-aaaa-1111")).toEqual(["api.openai.com"]);
    expect(resolveResourceAllowlist("resource-bbbb-2222")).toEqual([
      "api.weather.example.com",
    ]);
    expect(resolveResourceAllowlist("resource-unmapped-9999")).toEqual([]);
  });
});
