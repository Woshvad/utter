// marketplace.test.ts - the assembled marketplace is internally consistent and installable.
import { describe, it, expect } from "vitest";
import { buildMarketplace } from "../src/marketplace.js";
import { resourceFromAgentCard } from "../src/adapters.js";
import { expectKebab } from "./helpers.js";
import { LIVE_UTC_CARD, LIVE_UTC_TOOL_NAME, pluginResource } from "./fixtures.js";

describe("buildMarketplace", () => {
  it("lists the base plugin + one plugin per resource, with sources that resolve to emitted dirs", () => {
    const resources = [pluginResource(), resourceFromAgentCard(LIVE_UTC_CARD)];
    const { manifest, files, pluginNames } = buildMarketplace(resources, {});

    // Manifest shape.
    expect(manifest.name).toBe("utter");
    expect((manifest.owner as Record<string, unknown>).name).toBe("Utter");
    const entries = manifest.plugins as Array<{ name: string; source: string }>;
    expect(entries.length).toBe(3); // base + 2 endpoints
    expect(pluginNames[0]).toBe("utter-buyer");

    // marketplace.json is emitted at the root.
    expect(files[".claude-plugin/marketplace.json"]).toBeTruthy();

    // Every entry name is kebab, its source starts with ./plugins/, and the referenced dir
    // actually contains a plugin.json in the file map (source resolves to an emitted plugin).
    for (const entry of entries) {
      expectKebab(entry.name);
      expect(entry.source).toBe(`./plugins/${entry.name}`);
      expect(files[`plugins/${entry.name}/.claude-plugin/plugin.json`]).toBeTruthy();
    }

    // Every emitted plugin.json is listed in the manifest (no orphan dirs).
    const emitted = Object.keys(files)
      .filter((k) => k.endsWith("/.claude-plugin/plugin.json"))
      .map((k) => k.split("/")[1]);
    const listed = new Set(entries.map((e) => e.name));
    for (const name of emitted) expect(listed.has(name!)).toBe(true);
  });

  it("generates the real UTC endpoint's plugin with the correct scoped tool", () => {
    const resource = resourceFromAgentCard(LIVE_UTC_CARD);
    const { files } = buildMarketplace([resource], { includeBasePlugin: false });
    const name = "utter-return-the-current-utc-time-as-json";
    const raw = files[`plugins/${name}/.claude-plugin/plugin.json`];
    expect(raw).toBeTruthy();
    const m = JSON.parse(raw!) as Record<string, unknown>;
    const servers = m.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers["utter-buyer"]!.env.UTTER_RESOURCE_IDS).toBe(resource.resourceId);
    const skill = files[`plugins/${name}/skills/return-the-current-utc-time-as-json/SKILL.md`];
    expect(skill).toContain(LIVE_UTC_TOOL_NAME);
  });

  it("de-duplicates colliding plugin names (two resources, same slug)", () => {
    const a = pluginResource({ resourceId: `0x${"11".repeat(32)}`, slug: "same-slug" });
    const b = pluginResource({ resourceId: `0x${"22".repeat(32)}`, slug: "same-slug" });
    const { pluginNames, files } = buildMarketplace([a, b], { includeBasePlugin: false });
    const endpointNames = pluginNames.filter((n) => n !== "utter-buyer");
    expect(new Set(endpointNames).size).toBe(endpointNames.length); // all unique
    // Both dirs exist and each plugin.json name matches its own dir.
    for (const name of endpointNames) {
      const m = JSON.parse(files[`plugins/${name}/.claude-plugin/plugin.json`]!) as { name: string };
      expect(m.name).toBe(name);
    }
  });

  it("collision suffix keeps the tool scope correct for each distinct resource", () => {
    const a = pluginResource({ resourceId: `0x${"11".repeat(32)}`, slug: "dup" });
    const b = pluginResource({ resourceId: `0x${"22".repeat(32)}`, slug: "dup" });
    const { pluginNames, files } = buildMarketplace([a, b], { includeBasePlugin: false });
    const scopes = pluginNames
      .filter((n) => n !== "utter-buyer")
      .map((name) => {
        const m = JSON.parse(files[`plugins/${name}/.claude-plugin/plugin.json`]!) as {
          mcpServers: Record<string, { env: Record<string, string> }>;
        };
        return m.mcpServers["utter-buyer"]!.env.UTTER_RESOURCE_IDS;
      });
    // The two plugins scope to the two DISTINCT resourceIds (no cross-wiring).
    expect(new Set(scopes)).toEqual(new Set([a.resourceId, b.resourceId]));
  });

  it("keeps de-duplicated names within the 64-char plugin-name bound (long colliding slugs)", () => {
    // Two DISTINCT long slugs that both kebab-truncate to the same 56-char base -> collision,
    // so the second gets a hex suffix. The suffixed name must NOT exceed MAX_PLUGIN_NAME (64),
    // since the plugin name is also the MCP tool namespace.
    const longA = "a".repeat(56);
    const longB = "a".repeat(60); // truncates to the same 56 'a's as longA
    const a = pluginResource({ resourceId: `0x${"11".repeat(32)}`, slug: longA });
    const b = pluginResource({ resourceId: `0x${"22".repeat(32)}`, slug: longB });
    const { pluginNames } = buildMarketplace([a, b], { includeBasePlugin: false });
    const endpointNames = pluginNames.filter((n) => n !== "utter-buyer");
    expect(new Set(endpointNames).size).toBe(2); // unique
    for (const name of endpointNames) {
      expect(name.length).toBeLessThanOrEqual(64);
      expectKebab(name);
    }
  });

  it("honors --no-base and a custom plugin root", () => {
    const { pluginNames, files, manifest } = buildMarketplace([pluginResource()], {
      includeBasePlugin: false,
      pluginRoot: "./apps/x/plugins",
    });
    expect(pluginNames).not.toContain("utter-buyer");
    const entry = (manifest.plugins as Array<{ source: string }>)[0]!;
    expect(entry.source).toBe("./apps/x/plugins/utter-translate-text");
    expect(files["apps/x/plugins/utter-translate-text/.claude-plugin/plugin.json"]).toBeTruthy();
    expect((manifest.metadata as Record<string, unknown>).pluginRoot).toBe("./apps/x/plugins");
  });

  it("rejects a reserved or malformed marketplace name", () => {
    expect(() => buildMarketplace([], { marketplaceName: "anthropic-plugins" })).toThrow(/reserved/);
    expect(() => buildMarketplace([], { marketplaceName: "Not Kebab" })).toThrow(/kebab/);
  });

  it("produces a base-plugin-only marketplace from an empty resource list", () => {
    const { pluginNames, manifest } = buildMarketplace([], {});
    expect(pluginNames).toEqual(["utter-buyer"]);
    expect((manifest.plugins as unknown[]).length).toBe(1);
  });
});
