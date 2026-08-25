// plugin.ts - build ONE Claude Code plugin (its plugin.json + skill + readme + command)
// for either a single Utter endpoint or the base "buyer" plugin. Pure: returns a file map,
// touches no disk (write.ts materializes it).
//
// The generated plugin.json follows the authoritative Claude Code manifest schema: `name`
// (kebab-case, the install id + tool-name namespace) plus an inline `mcpServers` block and,
// for a live plugin, a `userConfig` block. NONE of the money fields is authored here - the
// buyer SDK re-pins escrow/asset/payTo/cap on the served card before signing.
import type { BuiltPlugin, FileMap, PluginGenOptions, PluginResource } from "./types.js";
import {
  buildMcpServers,
  buildUserConfig,
  DEFAULT_MCP_PUBLISHED,
  type PluginMode,
} from "./mcp.js";
import {
  isBytes32,
  isKebab,
  isValidPluginName,
  MAX_PLUGIN_NAME,
  pluginNameForResource,
  skillDirForResource,
} from "./naming.js";
import {
  renderBaseReadme,
  renderBaseSkill,
  renderDiscoverCommand,
  renderEndpointReadme,
  renderEndpointSkill,
} from "./skill.js";

/** The generator defaults (one place). */
const DEFAULTS = {
  marketplaceName: "utter",
  ownerName: "Utter",
  ownerUrl: "https://utter.technology",
  version: "0.1.0",
  pluginRoot: "./plugins",
  appUrl: "https://app.utter.technology",
} as const;

/** Options with every default filled (marketplaceIndexUrl stays optional). */
export interface ResolvedOptions {
  marketplaceName: string;
  ownerName: string;
  ownerUrl: string;
  version: string;
  pluginRoot: string;
  appUrl: string;
  mcp: { command: string; args: string[] };
  marketplaceIndexUrl?: string;
}

/** Fill defaults without letting an explicit `undefined` clobber a default. */
export function resolveOptions(opts: PluginGenOptions = {}): ResolvedOptions {
  return {
    marketplaceName: opts.marketplaceName ?? DEFAULTS.marketplaceName,
    ownerName: opts.ownerName ?? DEFAULTS.ownerName,
    ownerUrl: opts.ownerUrl ?? DEFAULTS.ownerUrl,
    version: opts.version ?? DEFAULTS.version,
    pluginRoot: opts.pluginRoot ?? DEFAULTS.pluginRoot,
    appUrl: opts.appUrl ?? DEFAULTS.appUrl,
    mcp: opts.mcp ?? DEFAULT_MCP_PUBLISHED,
    marketplaceIndexUrl: opts.marketplaceIndexUrl,
  };
}

/** Serialize an object as pretty JSON with a trailing newline (git-friendly). */
function jsonFile(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** The author block shared by generated plugins. */
function authorBlock(r: ResolvedOptions): Record<string, unknown> {
  return { name: r.ownerName, url: r.ownerUrl };
}

/**
 * Build the base "buyer" plugin: discovery + pay tools for ANY Utter endpoint, plus a
 * `using-utter` skill and a `/utter-buyer:discover` command. Defaults to demo mode (boots
 * with no config and runs the in-process escrow loop).
 */
export function buildBasePlugin(
  opts: PluginGenOptions = {},
  mode: PluginMode = "demo",
): BuiltPlugin {
  const r = resolveOptions(opts);
  const name = "utter-buyer";
  if (!isKebab(name)) throw new Error(`plugin-gen: invalid base plugin name "${name}"`);

  const userConfig = buildUserConfig({ mode, marketplaceIndexUrl: r.marketplaceIndexUrl });
  const manifest: Record<string, unknown> = {
    name,
    displayName: "Utter buyer",
    version: r.version,
    description: "Discover and pay for Utter APIs from your agent (x402 escrow, USDC on Arc).",
    author: authorBlock(r),
    homepage: "https://docs.utter.technology",
    keywords: ["utter", "x402", "payments", "agent", "usdc", "arc"],
    mcpServers: buildMcpServers({ mcp: r.mcp, mode }),
    ...(userConfig ? { userConfig } : {}),
    metadata: { kind: "utter-buyer", mode },
  };

  const files: FileMap = {
    ".claude-plugin/plugin.json": jsonFile(manifest),
    "skills/using-utter/SKILL.md": renderBaseSkill({ opts: r, mode, pluginName: name }),
    "commands/discover.md": renderDiscoverCommand(),
    "README.md": renderBaseReadme({
      opts: r,
      mode,
      pluginName: name,
      marketplaceName: r.marketplaceName,
    }),
  };
  return { name, files };
}

/**
 * Build a per-endpoint plugin: the buyer MCP SCOPED to this one resource (so it exposes only
 * this endpoint's call tool) plus a SKILL describing the endpoint. Defaults to live mode (a
 * per-endpoint plugin represents a real deployed endpoint). Throws on a malformed resourceId.
 */
export function buildEndpointPlugin(
  resource: PluginResource,
  opts: PluginGenOptions = {},
  mode: PluginMode = "live",
  nameOverride?: string,
): BuiltPlugin {
  if (!isBytes32(resource.resourceId)) {
    throw new Error(
      `plugin-gen: resource "${resource.slug}" has a malformed resourceId ` +
        `"${resource.resourceId}" (expected 0x + 64 hex)`,
    );
  }
  const r = resolveOptions(opts);
  const name = nameOverride ?? pluginNameForResource(resource.slug);
  if (!isValidPluginName(name)) {
    throw new Error(
      `plugin-gen: plugin name "${name}" is not a valid kebab id within ${MAX_PLUGIN_NAME} chars`,
    );
  }
  const skillName = skillDirForResource(resource.slug);

  const userConfig = buildUserConfig({ mode, marketplaceIndexUrl: r.marketplaceIndexUrl });
  const manifest: Record<string, unknown> = {
    name,
    displayName: resource.title && resource.title.trim().length > 0 ? resource.title.trim() : resource.slug,
    version: r.version,
    description: resource.description,
    author: authorBlock(r),
    homepage: "https://docs.utter.technology",
    keywords: ["utter", "x402", "paid-api", ...(resource.category ? [resource.category] : [])],
    mcpServers: buildMcpServers({ mcp: r.mcp, mode, resourceId: resource.resourceId }),
    ...(userConfig ? { userConfig } : {}),
    metadata: {
      kind: "utter-endpoint",
      mode,
      resourceId: resource.resourceId,
      ...(resource.category ? { category: resource.category } : {}),
      ...(resource.agentId ? { agentId: resource.agentId } : {}),
      ...(resource.creator ? { creator: resource.creator } : {}),
    },
  };

  const files: FileMap = {
    ".claude-plugin/plugin.json": jsonFile(manifest),
    [`skills/${skillName}/SKILL.md`]: renderEndpointSkill({
      resource,
      opts: r,
      mode,
      pluginName: name,
      skillName,
    }),
    "README.md": renderEndpointReadme({
      resource,
      opts: r,
      mode,
      pluginName: name,
      marketplaceName: r.marketplaceName,
    }),
  };
  return { name, files };
}
