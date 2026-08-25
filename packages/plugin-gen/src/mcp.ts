// mcp.ts - build the `mcpServers` block + the `userConfig` a generated plugin declares.
//
// Every generated plugin bundles ONE stdio MCP server (the Utter buyer SDK's
// `utter-buyer-mcp`). Claude Code starts it when the plugin is enabled and exposes its
// tools as `mcp__plugin_<plugin-name>_<server-name>__<tool>` (server-name = MCP_SERVER_NAME).
//
// Two modes:
//   * "demo"  -> BUYER_SDK_TRANSPORT unset/"demo": the buyer MCP runs a self-contained
//                in-process wiring (mock chain + ephemeral wallet + echo card). It boots
//                with NO key and NO network and runs the REAL discover->reserve->settle
//                escrow loop against the mock chain. Zero config; nothing to fill in.
//   * "live"  -> BUYER_SDK_TRANSPORT=live: the operator-gated live path. Reads the funded
//                buyer key + the marketplace index from user-config, and (for a per-endpoint
//                plugin) scopes discovery to one resource via UTTER_RESOURCE_IDS. The live
//                buyer transport is provisioned separately (the same gate as the rest of
//                live Utter); until then the server fail-louds on a call, by design.
//
// The buyer key is referenced as ${user_config.buyer_private_key} (sensitive) - it is held
// only inside the local MCP process, never baked into a committed file.
import type { McpLaunchConfig } from "./types.js";

/** The MCP server name the plugin registers the buyer SDK under (the tool-name namespace). */
export const MCP_SERVER_NAME = "utter-buyer";

/** The default (distribution) launch: the published buyer SDK via npx. */
export const DEFAULT_MCP_PUBLISHED: McpLaunchConfig = {
  command: "npx",
  args: ["-y", "@utter/buyer-sdk", "utter-buyer-mcp"],
};

/**
 * The repo-local launch: run the buyer MCP straight from the workspace via the
 * ${CLAUDE_PROJECT_DIR}/scripts/utter-buyer-mcp.mjs launcher (resolves to the project root
 * when Claude Code runs inside the utter repo). This makes the committed marketplace work
 * TODAY for the repo owner with no npm publish.
 *
 * It runs the launcher as the MAIN script (not via `--import`): on Windows `node --import
 * C:\...` throws ERR_UNSUPPORTED_ESM_URL_SCHEME, but an absolute Windows path IS valid as the
 * main script argument. The launcher registers the TS resolve hook with an import.meta.url
 * relative URL (also Windows-safe). `projectDirVar` is the literal Claude Code variable.
 */
export function localMcp(projectDirVar = "${CLAUDE_PROJECT_DIR}"): McpLaunchConfig {
  return {
    command: "node",
    args: ["--experimental-strip-types", `${projectDirVar}/scripts/utter-buyer-mcp.mjs`],
  };
}

/** The plugin mode: a zero-config in-process demo, or the operator-gated live path. */
export type PluginMode = "demo" | "live";

export interface BuildMcpServersOptions {
  /** How to launch the buyer MCP (command + args). */
  mcp: McpLaunchConfig;
  /** demo (in-process, no config) or live (operator-gated, keyed). */
  mode: PluginMode;
  /** For a per-endpoint LIVE plugin: scope discovery to this one resourceId. */
  resourceId?: string;
}

/**
 * Build the single-server `mcpServers` object. In demo mode the env only pins the transport
 * to demo (no key, no url). In live mode it wires the user-config key + marketplace url, and
 * (when `resourceId` is set) the per-endpoint scope. `${user_config.*}` is substituted by
 * Claude Code from the plugin's user-config at launch.
 */
export function buildMcpServers(opts: BuildMcpServersOptions): Record<string, unknown> {
  const env: Record<string, string> =
    opts.mode === "live"
      ? {
          BUYER_SDK_TRANSPORT: "live",
          MARKETPLACE_INDEX_URL: "${user_config.marketplace_url}",
          BUYER_PRIVATE_KEY: "${user_config.buyer_private_key}",
        }
      : { BUYER_SDK_TRANSPORT: "demo" };
  if (opts.mode === "live" && opts.resourceId) {
    env.UTTER_RESOURCE_IDS = opts.resourceId;
  }
  return {
    [MCP_SERVER_NAME]: {
      command: opts.mcp.command,
      args: opts.mcp.args,
      env,
    },
  };
}

/**
 * Build the plugin `userConfig` block. Demo plugins need no config (return null). Live
 * plugins require the funded buyer key (sensitive) + the marketplace index URL (defaulted
 * to `marketplaceIndexUrl` when the generator was given one).
 */
export function buildUserConfig(opts: {
  mode: PluginMode;
  marketplaceIndexUrl?: string;
}): Record<string, unknown> | null {
  if (opts.mode !== "live") return null;
  const marketplace: Record<string, unknown> = {
    type: "string",
    title: "Marketplace index URL",
    description:
      "The Utter marketplace base URL the buyer reads for discovery (it fetches GET {url}/resources).",
    required: true,
  };
  if (opts.marketplaceIndexUrl && opts.marketplaceIndexUrl.length > 0) {
    marketplace.default = opts.marketplaceIndexUrl;
  }
  return {
    buyer_private_key: {
      type: "string",
      title: "Buyer private key",
      description:
        "A funded Arc testnet buyer EOA private key. Held only inside the local MCP process to sign USDC escrow payments; it never leaves your machine and is never a tool argument or return.",
      sensitive: true,
      required: true,
    },
    marketplace_url: marketplace,
  };
}
