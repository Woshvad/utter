// types.ts - the data contracts the plugin generator builds against.
//
// A PluginResource is the projection of ONE published Utter endpoint that the generator
// needs to emit a Claude Code plugin: the resourceId (which derives the buyer MCP call
// tool name + the per-endpoint scope), the discovery slug + human text, the metered
// pricing block (base units, strings - never scaled by a decimals literal), and the
// display-only reputation fields. It is deliberately a SUPERSET-friendly, plain shape so
// both the marketplace GET /resources row and an A2A agent card map onto it (see adapters.ts).
//
// NONE of these fields is a money authority. The generated plugin's payments flow through
// the buyer SDK, which re-pins escrow/asset/payTo/cap against the trusted @utter/chain
// constants on the served card before signing. The generator only renders text + config.

/** The metered pricing block, in token base units (strings, never a 1e6 literal). */
export interface PluginPricing {
  /** The pricing model (metered / flat). */
  model: string;
  /** The per-call base charge in base units. */
  base: string;
  /** The per-KB charge in base units. */
  perKB: string;
  /** The escrow cap (max debit) in base units - the on-chain hard bound per call. */
  max: string;
}

/** One published endpoint, projected to what the generator needs. */
export interface PluginResource {
  /** The on-chain resourceId (0x + 64 hex). Derives the call tool name + the plugin scope. */
  resourceId: string;
  /** The discovery slug (the A2A card `name`). The plugin/skill names derive from this. */
  slug: string;
  /** A human title for the endpoint (defaults to the slug when absent). */
  title?: string;
  /** What the endpoint does (the A2A card `description`). */
  description: string;
  /** The listing category (data / compute / ...), when known. */
  category?: string;
  /** The metered pricing block (base units, strings). */
  pricing: PluginPricing;
  /** Whether the initial verification probe passed (display only). */
  verified?: boolean;
  /** The ERC-8004 agentId (reputation identity), when minted. */
  agentId?: string;
  /** Whether a stake bond is posted (display only). */
  bondPosted?: boolean;
  /** The absolute URL the resource's agent card is served at, when known. */
  cardUrl?: string;
  /** The on-chain creator/owner address, when known (author metadata only). */
  creator?: string;
}

/** How the generated plugin launches the buyer MCP server (a stdio command + args). */
export interface McpLaunchConfig {
  /** The executable (default: "npx"). */
  command: string;
  /** The arguments (default: ["-y", "@utter/buyer-sdk", "utter-buyer-mcp"]). */
  args: string[];
}

/** Options that shape a whole generated marketplace. */
export interface PluginGenOptions {
  /** The marketplace `name` (kebab-case). Default "utter". */
  marketplaceName?: string;
  /** The marketplace/plugin author name. Default "Utter". */
  ownerName?: string;
  /** The author URL. Default "https://utter.technology". */
  ownerUrl?: string;
  /** The plugin + marketplace version (semver). Default "0.1.0". */
  version?: string;
  /** How to launch the buyer MCP server (default: the published-package npx form). */
  mcp?: McpLaunchConfig;
  /**
   * The marketplace index URL the bundled buyer MCP reads for discovery. When set it becomes
   * the DEFAULT of the plugin's `marketplace_url` user-config field (the user can still
   * override it at install). When absent the field has no default and the user must supply it.
   */
  marketplaceIndexUrl?: string;
  /**
   * The directory (relative to the marketplace root, starting with "./") the plugin folders
   * are written under and referenced from in marketplace.json. Default "./plugins".
   */
  pluginRoot?: string;
  /** The app URL surfaced in READMEs/skills. Default "https://app.utter.technology". */
  appUrl?: string;
}

/** A map of file path (relative, POSIX "/" separators) to file content. */
export type FileMap = Record<string, string>;

/** One built plugin: its (kebab) name + the files under its plugin directory. */
export interface BuiltPlugin {
  /** The plugin `name` (kebab-case), also the install id and the tool-name namespace. */
  name: string;
  /** The files under the plugin dir, keyed by path relative to the plugin root. */
  files: FileMap;
}

/** A built marketplace: the parsed manifest object + every file keyed from the market root. */
export interface BuiltMarketplace {
  /** The parsed marketplace.json manifest (also serialized into `files`). */
  manifest: Record<string, unknown>;
  /** Every file, keyed by path relative to the marketplace root (POSIX separators). */
  files: FileMap;
  /** The plugin names that were emitted (base plugin first, then one per resource). */
  pluginNames: string[];
}
