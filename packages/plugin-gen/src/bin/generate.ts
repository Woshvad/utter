#!/usr/bin/env node
// bin/generate.ts - `utter-plugins`: generate the installable Claude Code plugin marketplace
// from published Utter endpoints and write it to disk. This is the auto-publish step:
// each live endpoint becomes a one-command-installable plugin.
//
// Sources (pick one, or none for a base-plugin-only marketplace):
//   --marketplace-url <url>   read the live GET {url}/resources index (add --enrich to pull
//                             each endpoint's description from its agent card)
//   --card <url>              read one endpoint's /.well-known/agent-card.json (repeatable)
//   --source <file.json>      read an array of marketplace rows or agent cards from a file
//
// Wiring + output:
//   --out <dir>               where to write (default: cwd). Writes .claude-plugin/ + plugins/
//   --local                   launch the buyer MCP from the workspace via ${CLAUDE_PROJECT_DIR}
//                             (works today in the utter repo, no npm publish)
//   --published               launch via `npx -y @utter/buyer-sdk utter-buyer-mcp` (default)
//   --prune                   remove the plugin root before writing (drop stale plugins)
//   --no-base                 omit the base "utter-buyer" plugin
//   --name / --owner          marketplace name / author name
//   --base-mode / --endpoint-mode   demo | live (defaults: base=demo, endpoint=live)
//
// This CLI writes to STDOUT (it is not an MCP stdio server); diagnostics are plain logs.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config as loadDotenv } from "dotenv";

import { buildMarketplace, type BuildMarketplaceOptions } from "../marketplace.js";
import { resourceFromAgentCard, resourceFromIndexRow } from "../adapters.js";
import { fetchResources, enrichDescriptions, type FetchLike } from "../fetch-resources.js";
import { DEFAULT_MCP_PUBLISHED, localMcp, type PluginMode } from "../mcp.js";
import { writeFiles, relPosix } from "../write.js";
import type { PluginResource } from "../types.js";

/** The global fetch, typed as the injectable FetchLike the readers expect. */
const globalFetcher = globalThis.fetch as unknown as FetchLike;

function asMode(value: string | undefined, fallback: PluginMode): PluginMode {
  return value === "demo" || value === "live" ? value : fallback;
}

/** Map an array of untrusted items (agent cards or index rows) to PluginResource[]. */
function resourcesFromArray(items: unknown[]): PluginResource[] {
  return items.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    if ("x402" in obj) return resourceFromAgentCard(obj);
    return resourceFromIndexRow(obj as never);
  });
}

async function fetchCard(url: string): Promise<PluginResource> {
  const res = await globalFetcher(url, { method: "GET", headers: { accept: "application/json" } });
  if (res.status !== 200) {
    throw new Error(`utter-plugins: agent card ${url} returned HTTP ${res.status}`);
  }
  const card = (await res.json()) as Record<string, unknown>;
  return resourceFromAgentCard(card, { cardUrl: url });
}

async function main(): Promise<void> {
  loadDotenv({ path: ".env.local", quiet: true });

  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "marketplace-url": { type: "string" },
      source: { type: "string" },
      card: { type: "string", multiple: true },
      local: { type: "boolean" },
      published: { type: "boolean" },
      name: { type: "string" },
      owner: { type: "string" },
      "no-base": { type: "boolean" },
      prune: { type: "boolean" },
      enrich: { type: "boolean" },
      "plugin-root": { type: "string" },
      "base-mode": { type: "string" },
      "endpoint-mode": { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log("Usage: utter-plugins [--marketplace-url <url> | --card <url> | --source <file>]");
    console.log("       [--out <dir>] [--local|--published] [--prune] [--no-base]");
    console.log("       [--name <mkt>] [--owner <name>] [--enrich]");
    console.log("       [--plugin-root <./plugins>] [--base-mode demo|live] [--endpoint-mode demo|live]");
    return;
  }

  const outDir = values.out ?? process.cwd();
  const marketplaceIndexUrl =
    values["marketplace-url"] ?? process.env.MARKETPLACE_INDEX_URL ?? undefined;

  // Gather endpoints from whichever source was named (all combine).
  let resources: PluginResource[] = [];
  if (values.source) {
    const raw = await readFile(values.source, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (parsed?.resources ?? []);
    resources = resources.concat(resourcesFromArray(items));
  }
  if (values.card && values.card.length > 0) {
    for (const url of values.card) resources.push(await fetchCard(url));
  }
  if (!values.source && (!values.card || values.card.length === 0) && marketplaceIndexUrl) {
    let live = await fetchResources({ marketplaceIndexUrl });
    if (values.enrich) live = await enrichDescriptions(live);
    resources = resources.concat(live);
  }

  const mcp = values.local ? localMcp() : DEFAULT_MCP_PUBLISHED;
  const opts: BuildMarketplaceOptions = {
    marketplaceName: values.name,
    ownerName: values.owner,
    mcp,
    marketplaceIndexUrl,
    pluginRoot: values["plugin-root"],
    includeBasePlugin: values["no-base"] ? false : true,
    baseMode: asMode(values["base-mode"], "demo"),
    endpointMode: asMode(values["endpoint-mode"], "live"),
  };

  const market = buildMarketplace(resources, opts);
  const prune = values.prune
    ? [(values["plugin-root"] ?? "./plugins").replace(/^\.\//, "").replace(/\/+$/, "")]
    : undefined;
  const written = await writeFiles(outDir, market.files, { prune });

  console.log(`utter-plugins: wrote ${written.length} files to ${outDir}`);
  console.log(`  marketplace: ${market.manifest.name} (${market.pluginNames.length} plugins)`);
  for (const name of market.pluginNames) console.log(`  - ${name}`);
  console.log(`  manifest: ${relPosix(outDir, written.find((p) => p.endsWith("marketplace.json")) ?? "")}`);
  console.log("");
  console.log("Install:");
  console.log(`  /plugin marketplace add ${outDir === process.cwd() ? "Woshvad/utter" : outDir}`);
  console.log(`  /plugin install utter-buyer@${market.manifest.name}`);
}

main().catch((err: unknown) => {
  console.error("utter-plugins: fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
