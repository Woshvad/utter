// @utter/plugin-gen - turn published Utter endpoints into an installable Claude Code plugin
// marketplace. Each endpoint becomes a plugin whose bundled buyer MCP lets an agent discover,
// pay for, and call it through the escrow response gate. This is the supply-to-distribution
// bridge: `you utter a sentence` -> a paid API -> a one-command-installable agent tool.
//
// Public surface: the pure builders (plugin + marketplace), the source adapters, the live
// reader, and the fs writer. Everything is dependency-free and unit tested offline.

export type {
  PluginPricing,
  PluginResource,
  McpLaunchConfig,
  PluginGenOptions,
  FileMap,
  BuiltPlugin,
  BuiltMarketplace,
} from "./types.js";

export {
  resourceIdCore,
  toolNameForResource,
  toKebab,
  pluginNameForResource,
  skillDirForResource,
  isKebab,
  isValidPluginName,
  boundedSuffix,
  isBytes32,
  MAX_PLUGIN_NAME,
} from "./naming.js";

export {
  MCP_SERVER_NAME,
  DEFAULT_MCP_PUBLISHED,
  localMcp,
  buildMcpServers,
  buildUserConfig,
  type PluginMode,
  type BuildMcpServersOptions,
} from "./mcp.js";

export {
  buildBasePlugin,
  buildEndpointPlugin,
  resolveOptions,
  type ResolvedOptions,
} from "./plugin.js";

export {
  buildMarketplace,
  type BuildMarketplaceOptions,
} from "./marketplace.js";

export {
  resourceFromIndexRow,
  resourceFromAgentCard,
  type MarketplaceIndexRow,
} from "./adapters.js";

export {
  fetchResources,
  enrichDescriptions,
  type FetchLike,
} from "./fetch-resources.js";

export { writeFiles, relPosix } from "./write.js";

export {
  priceLine,
  renderEndpointSkill,
  renderBaseSkill,
  renderDiscoverCommand,
  renderEndpointReadme,
  renderBaseReadme,
} from "./skill.js";
