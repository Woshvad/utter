// plugin.test.ts - the per-plugin builders emit a schema-valid, resource-correct plugin.
import { describe, it, expect } from "vitest";
import { buildBasePlugin, buildEndpointPlugin } from "../src/plugin.js";
import { localMcp } from "../src/mcp.js";
import { toolNameForResource } from "../src/naming.js";
import { parseFrontmatter, pluginManifest, expectKebab } from "./helpers.js";
import { pluginResource } from "./fixtures.js";

describe("buildEndpointPlugin", () => {
  it("emits a valid manifest scoped to the resource, with a matching SKILL and README", () => {
    const resource = pluginResource();
    const { name, files } = buildEndpointPlugin(resource);

    expect(name).toBe("utter-translate-text");
    expectKebab(name);

    // Files present.
    expect(Object.keys(files).sort()).toEqual(
      [".claude-plugin/plugin.json", "README.md", "skills/translate-text/SKILL.md"].sort(),
    );

    const m = pluginManifest(files);
    expect(m.name).toBe(name);
    expect(typeof m.version).toBe("string");
    expect(m.description).toBe(resource.description);
    expect((m.keywords as string[])).toContain("compute"); // the category

    // mcpServers: one utter-buyer stdio server, live, scoped to THIS resourceId.
    const servers = m.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    const server = servers["utter-buyer"];
    expect(server).toBeTruthy();
    expect(server!.env.BUYER_SDK_TRANSPORT).toBe("live");
    expect(server!.env.UTTER_RESOURCE_IDS).toBe(resource.resourceId);
    expect(server!.env.MARKETPLACE_INDEX_URL).toBe("${user_config.marketplace_url}");
    expect(server!.env.BUYER_PRIVATE_KEY).toBe("${user_config.buyer_private_key}");

    // userConfig: a sensitive buyer key + the marketplace url (live plugins only).
    const uc = m.userConfig as Record<string, { sensitive?: boolean; required?: boolean }>;
    expect(uc.buyer_private_key!.sensitive).toBe(true);
    expect(uc.buyer_private_key!.required).toBe(true);
    expect(uc.marketplace_url!.required).toBe(true);

    // metadata carries the resourceId.
    expect((m.metadata as Record<string, unknown>).resourceId).toBe(resource.resourceId);

    // SKILL frontmatter + body reference the exact call tool name.
    const skill = parseFrontmatter(files["skills/translate-text/SKILL.md"]!);
    expect(skill.fields.name).toBe("translate-text");
    const desc = skill.fields.description ?? "";
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1536);
    expect(skill.body).toContain(toolNameForResource(resource.resourceId));
    expect(skill.body).toContain(resource.resourceId);
  });

  it("uses the marketplaceIndexUrl as the marketplace_url default when provided", () => {
    const { files } = buildEndpointPlugin(pluginResource(), {
      marketplaceIndexUrl: "https://market.utter.technology",
    });
    const m = pluginManifest(files);
    const uc = m.userConfig as Record<string, { default?: string }>;
    expect(uc.marketplace_url!.default).toBe("https://market.utter.technology");
  });

  it("honors a demo mode (no key/url env, no userConfig)", () => {
    const { files } = buildEndpointPlugin(pluginResource(), {}, "demo");
    const m = pluginManifest(files);
    const servers = m.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers["utter-buyer"]!.env.BUYER_SDK_TRANSPORT).toBe("demo");
    expect(servers["utter-buyer"]!.env.BUYER_PRIVATE_KEY).toBeUndefined();
    expect(m.userConfig).toBeUndefined();
  });

  it("threads a local MCP launch command (repo-relative via CLAUDE_PROJECT_DIR)", () => {
    const { files } = buildEndpointPlugin(pluginResource(), { mcp: localMcp() });
    const m = pluginManifest(files);
    const servers = m.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers["utter-buyer"]!.command).toBe("node");
    expect(servers["utter-buyer"]!.args.join(" ")).toContain("${CLAUDE_PROJECT_DIR}");
    expect(servers["utter-buyer"]!.args.join(" ")).toContain("scripts/utter-buyer-mcp.mjs");
    // Windows-safe: the launcher is the MAIN script arg, never a `--import C:\...` (which
    // throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows).
    expect(servers["utter-buyer"]!.args).not.toContain("--import");
  });

  it("throws on a malformed resourceId (never emits a bad tool name/scope)", () => {
    expect(() => buildEndpointPlugin(pluginResource({ resourceId: "0x1234" }))).toThrow(/resourceId/);
  });

  it("respects a name override (for marketplace-level de-duplication)", () => {
    const { name, files } = buildEndpointPlugin(pluginResource(), {}, "live", "utter-translate-text-abc123");
    expect(name).toBe("utter-translate-text-abc123");
    expect(pluginManifest(files).name).toBe("utter-translate-text-abc123");
  });
});

describe("buildBasePlugin", () => {
  it("emits a demo-mode discovery plugin with a skill + command and no required config", () => {
    const { name, files } = buildBasePlugin();
    expect(name).toBe("utter-buyer");

    expect(Object.keys(files).sort()).toEqual(
      [".claude-plugin/plugin.json", "README.md", "commands/discover.md", "skills/using-utter/SKILL.md"].sort(),
    );

    const m = pluginManifest(files);
    const servers = m.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers["utter-buyer"]!.env.BUYER_SDK_TRANSPORT).toBe("demo");
    expect(m.userConfig).toBeUndefined();

    const skill = parseFrontmatter(files["skills/using-utter/SKILL.md"]!);
    expect(skill.fields.name).toBe("using-utter");
    expect(skill.body).toContain("utter_discover_endpoints");

    const cmd = parseFrontmatter(files["commands/discover.md"]!);
    expect((cmd.fields.description ?? "").length).toBeGreaterThan(0);
  });

  it("can be built in live mode with the buyer-key userConfig", () => {
    const { files } = buildBasePlugin({}, "live");
    const m = pluginManifest(files);
    const servers = m.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers["utter-buyer"]!.env.BUYER_SDK_TRANSPORT).toBe("live");
    expect((m.userConfig as Record<string, unknown>).buyer_private_key).toBeTruthy();
  });
});
