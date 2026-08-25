// marketplace.ts - assemble a whole installable Claude Code plugin marketplace from a set of
// published Utter endpoints: the base buyer plugin + one plugin per endpoint, plus the
// `.claude-plugin/marketplace.json` that lists them. Pure: returns a file map keyed from the
// marketplace root; write.ts materializes it to disk.
import type {
  BuiltMarketplace,
  BuiltPlugin,
  FileMap,
  PluginGenOptions,
  PluginResource,
} from "./types.js";
import type { PluginMode } from "./mcp.js";
import { buildBasePlugin, buildEndpointPlugin, resolveOptions } from "./plugin.js";
import { boundedSuffix, isKebab, pluginNameForResource, resourceIdCore } from "./naming.js";

/** Marketplace names Claude Code reserves for first-party/official use (cannot be claimed). */
const RESERVED_MARKETPLACE_NAMES = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "claude-plugins-community",
  "claude-community",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "knowledge-work-plugins",
  "life-sciences",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
  "healthcare",
]);

/** Options for {@link buildMarketplace}. */
export interface BuildMarketplaceOptions extends PluginGenOptions {
  /** Include the base "utter-buyer" discovery plugin (default true). */
  includeBasePlugin?: boolean;
  /** The mode for the base plugin (default "demo": boots with no config). */
  baseMode?: PluginMode;
  /** The mode for per-endpoint plugins (default "live"). */
  endpointMode?: PluginMode;
}

/** Serialize an object as pretty JSON with a trailing newline. */
function jsonFile(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** The file-path prefix (POSIX, no leading "./" or trailing "/") a pluginRoot maps to. */
function pluginRootPrefix(pluginRoot: string): string {
  return pluginRoot.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The marketplace `source` for a plugin dir (relative to the market root, starts with "./"). */
function pluginSource(pluginRoot: string, name: string): string {
  const root = pluginRoot.replace(/\/+$/, "");
  const prefixed = root.startsWith("./") || root.startsWith("../") ? root : `./${root}`;
  return `${prefixed}/${name}`;
}

/**
 * Ensure a plugin name is unique within the marketplace; suffix with resourceId hex on clash.
 * The suffix is appended via boundedSuffix so the result NEVER exceeds MAX_PLUGIN_NAME even when
 * the base name is already at the length bound (the name is also the MCP tool-name namespace).
 */
function uniquify(name: string, used: Set<string>, resourceId: string): string {
  if (!used.has(name)) return name;
  const hex = resourceIdCore(resourceId).slice(0, 6) || "x";
  let candidate = boundedSuffix(name, hex);
  let n = 2;
  while (used.has(candidate)) {
    candidate = boundedSuffix(name, `${hex}-${n}`);
    n += 1;
  }
  return candidate;
}

/** One marketplace `plugins[]` entry for a built plugin. */
function marketplaceEntry(args: {
  plugin: BuiltPlugin;
  pluginRoot: string;
  description: string;
  version: string;
  author: Record<string, unknown>;
  keywords: string[];
  category?: string;
}): Record<string, unknown> {
  return {
    name: args.plugin.name,
    source: pluginSource(args.pluginRoot, args.plugin.name),
    description: args.description,
    version: args.version,
    author: args.author,
    keywords: args.keywords,
    ...(args.category ? { category: args.category } : {}),
  };
}

/** Read the plugin.json fields we echo into the marketplace entry (single source: the manifest). */
function manifestOf(plugin: BuiltPlugin): Record<string, unknown> {
  const raw = plugin.files[".claude-plugin/plugin.json"];
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/**
 * Build the full marketplace. Emits the base buyer plugin (unless disabled) followed by one
 * plugin per resource, de-duplicating names, then the marketplace.json listing them all.
 */
export function buildMarketplace(
  resources: PluginResource[],
  opts: BuildMarketplaceOptions = {},
): BuiltMarketplace {
  const r = resolveOptions(opts);
  if (!isKebab(r.marketplaceName)) {
    throw new Error(`plugin-gen: marketplace name "${r.marketplaceName}" is not a valid kebab id`);
  }
  if (RESERVED_MARKETPLACE_NAMES.has(r.marketplaceName)) {
    throw new Error(`plugin-gen: marketplace name "${r.marketplaceName}" is reserved by Claude Code`);
  }

  const includeBase = opts.includeBasePlugin !== false;
  const baseMode: PluginMode = opts.baseMode ?? "demo";
  const endpointMode: PluginMode = opts.endpointMode ?? "live";
  const prefix = pluginRootPrefix(r.pluginRoot);

  const files: FileMap = {};
  const pluginNames: string[] = [];
  const used = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  const author = { name: r.ownerName, url: r.ownerUrl };

  const addPlugin = (plugin: BuiltPlugin, entry: Record<string, unknown>): void => {
    used.add(plugin.name);
    pluginNames.push(plugin.name);
    for (const [rel, content] of Object.entries(plugin.files)) {
      files[`${prefix}/${plugin.name}/${rel}`] = content;
    }
    entries.push(entry);
  };

  if (includeBase) {
    const base = buildBasePlugin(opts, baseMode);
    const m = manifestOf(base);
    addPlugin(
      base,
      marketplaceEntry({
        plugin: base,
        pluginRoot: r.pluginRoot,
        description: String(m.description ?? "Discover and pay for Utter APIs."),
        version: r.version,
        author,
        keywords: (m.keywords as string[]) ?? ["utter", "x402"],
      }),
    );
  }

  for (const resource of resources) {
    // Reserve the final (possibly de-duplicated) name FIRST, then build the plugin WITH it so
    // the plugin.json name, the tool-name namespace, and the marketplace source all agree.
    const natural = pluginNameForResource(resource.slug);
    const finalName = uniquify(natural, used, resource.resourceId);
    const plugin = buildEndpointPlugin(resource, opts, endpointMode, finalName);
    const m = manifestOf(plugin);
    addPlugin(
      plugin,
      marketplaceEntry({
        plugin,
        pluginRoot: r.pluginRoot,
        description: resource.description,
        version: r.version,
        author,
        keywords: (m.keywords as string[]) ?? ["utter", "x402", "paid-api"],
        category: resource.category,
      }),
    );
  }

  const manifest: Record<string, unknown> = {
    name: r.marketplaceName,
    owner: author,
    description: "Paid Utter APIs as installable Claude Code plugins. Agents pay per call in USDC on Arc.",
    version: r.version,
    metadata: { pluginRoot: r.pluginRoot },
    plugins: entries,
  };
  files[".claude-plugin/marketplace.json"] = jsonFile(manifest);

  return { manifest, files, pluginNames };
}
