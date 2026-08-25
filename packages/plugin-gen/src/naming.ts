// naming.ts - the pure, deterministic name derivations shared by the generator.
//
// Every identifier the generator emits (plugin name, skill directory, marketplace name)
// MUST be Claude Code kebab-case: /^[a-z0-9]+(-[a-z0-9]+)*$/. And the buyer MCP call tool
// name MUST match @utter/buyer-sdk's endpointToolName EXACTLY, or the generated skill would
// point the model at a tool that does not exist. Both derivations are unit-pinned in
// test/naming.test.ts (the tool-name test also cross-checks the buyer-sdk derivation shape).

/** The 0x-stripped, lowercased hex core of a resourceId (the tool-name + scope basis). */
export function resourceIdCore(resourceId: string): string {
  return resourceId.trim().replace(/^0x/i, "").toLowerCase();
}

/**
 * The buyer MCP per-endpoint CALL tool name for a resource. MIRRORS
 * packages/buyer-sdk/src/mcp/tools.ts `endpointToolName`: the FULL 32-byte resourceId
 * (64 hex chars), lowercased, 0x-stripped, prefixed `utter_call_`. Kept in lockstep with
 * that function (a drift would make the generated skill reference a non-existent tool);
 * test/naming.test.ts pins the exact format.
 */
export function toolNameForResource(resourceId: string): string {
  return `utter_call_${resourceIdCore(resourceId)}`;
}

/**
 * Coerce arbitrary text to Claude Code kebab-case (lowercase alnum segments joined by single
 * hyphens, no leading/trailing hyphen), bounded to `max` chars. Falls back to `fallback` when
 * the input has no alnum content. The result always satisfies /^[a-z0-9]+(-[a-z0-9]+)*$/.
 */
export function toKebab(input: string, max = 64, fallback = "resource"): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > max) {
    // Trim to the bound, then re-strip a hyphen the cut may have left dangling.
    s = s.slice(0, max).replace(/-+$/g, "");
  }
  return s.length > 0 ? s : fallback;
}

/**
 * The plugin `name` for an endpoint: `utter-<kebab(slug)>`, bounded so the whole name stays
 * a valid, reasonable-length kebab id. This is the install id (`/plugin install <name>@<mkt>`)
 * and the MCP tool-name namespace (`mcp__plugin_<name>_<server>__<tool>`).
 */
export function pluginNameForResource(slug: string): string {
  // Reserve room for the "utter-" prefix within a 64-char bound.
  return `utter-${toKebab(slug, 56, "resource")}`;
}

/** The skill directory name for an endpoint (kebab slug, bounded). */
export function skillDirForResource(slug: string): string {
  return toKebab(slug, 60, "endpoint");
}

/** The hard upper bound on a generated plugin name (also the MCP tool-name namespace). */
export const MAX_PLUGIN_NAME = 64;

/** True iff `name` is a valid Claude Code kebab identifier (charset only, no length bound). */
export function isKebab(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** True iff `name` is a valid plugin name: kebab AND within the {@link MAX_PLUGIN_NAME} bound. */
export function isValidPluginName(name: string): boolean {
  return isKebab(name) && name.length <= MAX_PLUGIN_NAME;
}

/**
 * Append `-<suffix>` to a kebab `name` while keeping the whole within {@link MAX_PLUGIN_NAME}:
 * the base is trimmed (and any dangling hyphen re-stripped) so `base-suffix` fits. Used by the
 * marketplace de-duplicator so a collision suffix on an already-long name cannot overflow the
 * bound (which is also the MCP tool namespace). The result stays valid kebab.
 */
export function boundedSuffix(name: string, suffix: string, max = MAX_PLUGIN_NAME): string {
  const room = max - (suffix.length + 1);
  const base = name.length > room ? name.slice(0, Math.max(1, room)).replace(/-+$/g, "") : name;
  return `${base}-${suffix}`;
}

/** True iff `resourceId` is a well-formed bytes32 (0x + 64 hex). */
export function isBytes32(resourceId: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(resourceId.trim());
}
