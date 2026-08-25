// naming.test.ts - pins the deterministic name derivations. The tool-name format is pinned
// against the REAL live resourceId so it stays in lockstep with @utter/buyer-sdk's
// endpointToolName (a drift would make generated skills reference a non-existent tool).
import { describe, it, expect } from "vitest";
import {
  boundedSuffix,
  isBytes32,
  isKebab,
  isValidPluginName,
  MAX_PLUGIN_NAME,
  pluginNameForResource,
  resourceIdCore,
  skillDirForResource,
  toKebab,
  toolNameForResource,
} from "../src/naming.js";
import { LIVE_UTC_RESOURCE_ID, LIVE_UTC_TOOL_NAME } from "./fixtures.js";

describe("naming", () => {
  it("derives the buyer MCP call tool name exactly as endpointToolName does (0x-stripped, lowercased, full 32 bytes)", () => {
    expect(toolNameForResource(LIVE_UTC_RESOURCE_ID)).toBe(LIVE_UTC_TOOL_NAME);
    // Case + 0x independence.
    expect(toolNameForResource(LIVE_UTC_RESOURCE_ID.toUpperCase())).toBe(LIVE_UTC_TOOL_NAME);
    expect(toolNameForResource(LIVE_UTC_RESOURCE_ID.replace(/^0x/, ""))).toBe(LIVE_UTC_TOOL_NAME);
    // Full 32-byte id -> 64 hex chars after the prefix (never an 8-char truncation).
    expect(LIVE_UTC_TOOL_NAME).toMatch(/^utter_call_[0-9a-f]{64}$/);
  });

  it("resourceIdCore strips 0x and lowercases", () => {
    expect(resourceIdCore("0xABCdef")).toBe("abcdef");
    expect(resourceIdCore("  0Xff  ")).toBe("ff");
  });

  it("toKebab produces valid kebab ids and honors the bound + fallback", () => {
    expect(toKebab("Return the current UTC time!")).toBe("return-the-current-utc-time");
    expect(toKebab("  --Weird__Name-- ")).toBe("weird-name");
    expect(isKebab(toKebab("a".repeat(200), 20))).toBe(true);
    expect(toKebab("a".repeat(200), 20).length).toBeLessThanOrEqual(20);
    expect(toKebab("!!!", 20, "fallback")).toBe("fallback");
    // A cut that would leave a trailing hyphen is re-trimmed.
    expect(toKebab("aaaa-bbbb-cccc", 5)).toBe("aaaa");
  });

  it("pluginNameForResource / skillDirForResource are valid kebab", () => {
    const name = pluginNameForResource("return-the-current-utc-time-as-json");
    expect(name).toBe("utter-return-the-current-utc-time-as-json");
    expectKebabLocal(name);
    expectKebabLocal(skillDirForResource("return-the-current-utc-time-as-json"));
    // Garbage slug still yields a valid name.
    expectKebabLocal(pluginNameForResource("$$$"));
  });

  it("boundedSuffix keeps a suffixed name within the plugin-name bound", () => {
    const long = `utter-${"a".repeat(56)}`; // 62 chars
    const out = boundedSuffix(long, "111111"); // would be 69 chars unbounded
    expect(out.length).toBeLessThanOrEqual(MAX_PLUGIN_NAME);
    expect(out.endsWith("-111111")).toBe(true);
    expect(isValidPluginName(out)).toBe(true);
    // A short name is suffixed verbatim.
    expect(boundedSuffix("utter-x", "abc123")).toBe("utter-x-abc123");
  });

  it("isValidPluginName enforces charset AND the length bound", () => {
    expect(isValidPluginName("utter-buyer")).toBe(true);
    expect(isValidPluginName("a".repeat(MAX_PLUGIN_NAME))).toBe(true);
    expect(isValidPluginName("a".repeat(MAX_PLUGIN_NAME + 1))).toBe(false);
    expect(isValidPluginName("Not-Kebab")).toBe(false);
  });

  it("isBytes32 accepts a well-formed id and rejects malformed ones", () => {
    expect(isBytes32(LIVE_UTC_RESOURCE_ID)).toBe(true);
    expect(isBytes32("0x1234")).toBe(false);
    expect(isBytes32("f8fa" + "0".repeat(60))).toBe(false); // missing 0x
    expect(isBytes32(`0x${"g".repeat(64)}`)).toBe(false); // non-hex
  });
});

function expectKebabLocal(name: string): void {
  expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
}
