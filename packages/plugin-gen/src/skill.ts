// skill.ts - render the human-facing files of a generated plugin: SKILL.md (the thing that
// teaches Claude when + how to use the endpoint), README.md, and the discovery command.
//
// House style: plain prose, no em dashes, no filler. The SKILL description is what Claude
// reads to decide whether to auto-invoke, so it names the endpoint, the price, and when to
// use it. Prices are shown in USDC BASE UNITS only (the SDK reads decimals() at call time;
// the generator never scales by a decimals literal).
import type { PluginResource, PluginGenOptions } from "./types.js";
import type { PluginMode } from "./mcp.js";
import { MCP_SERVER_NAME } from "./mcp.js";
import { toolNameForResource } from "./naming.js";

/** The SKILL/description length budget (Claude Code truncates the combined field at 1536). */
const DESCRIPTION_MAX = 1400;

/** A double-quoted YAML scalar: newlines collapsed, backslashes + quotes escaped. */
function yamlString(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${flat}"`;
}

/** Clamp a rendered description to the budget without cutting mid-escape. */
function clampDescription(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX - 1).trimEnd()}.` : flat;
}

/** The price line surfaced to the model + reader (base units only, never a decimals literal). */
export function priceLine(resource: PluginResource): string {
  const p = resource.pricing;
  return `base ${p.base} + ${p.perKB}/KB, cap ${p.max} (${p.model}, USDC base units) per call`;
}

/** The reputation line surfaced to the reader. */
function reputationLine(resource: PluginResource): string {
  const verified = resource.verified ? "verified" : "unverified";
  const bond = resource.bondPosted ? "bond posted" : "no bond";
  const agent = resource.agentId && resource.agentId !== "placeholder" ? `agentId ${resource.agentId}` : "agentId pending";
  return `${verified}, ${agent}, ${bond}`;
}

/** The human title (falls back to the slug). */
function titleOf(resource: PluginResource): string {
  return resource.title && resource.title.trim().length > 0 ? resource.title.trim() : resource.slug;
}

/**
 * Render the SKILL.md for a single endpoint. The model is told exactly which tool to call
 * (the buyer MCP's per-endpoint call tool) and that payment is gated on response validation.
 */
export function renderEndpointSkill(args: {
  resource: PluginResource;
  opts: Required<Pick<PluginGenOptions, "appUrl">> & PluginGenOptions;
  mode: PluginMode;
  pluginName: string;
  skillName: string;
}): string {
  const { resource, opts, mode, pluginName, skillName } = args;
  const title = titleOf(resource);
  const tool = toolNameForResource(resource.resourceId);
  const fqTool = `mcp__plugin_${pluginName}_${MCP_SERVER_NAME}__${tool}`;
  const docsUrl = "https://docs.utter.technology";

  const description = clampDescription(
    `${title}: ${resource.description}. A paid Utter API on Arc that agents call and pay for per call in USDC ` +
      `through the escrow response gate (you are charged only after the response passes validation). ` +
      `Price: ${priceLine(resource)}. Use this when you need: ${resource.description}.`,
  );

  const setup =
    mode === "live"
      ? [
          "## Setup",
          "",
          "This endpoint is live and paid. Before the first call, configure the plugin:",
          "",
          "1. `buyer_private_key`: a funded Arc testnet buyer key (kept only inside the local MCP process).",
          "2. `marketplace_url`: the Utter marketplace base URL used for discovery.",
          "",
          "Payments settle on Arc through the escrow contract. The live buyer path is operator-gated;",
          "see the docs for provisioning.",
        ].join("\n")
      : [
          "## Setup",
          "",
          "This plugin runs the buyer in demo mode (in-process, no real money and no configuration).",
          "It exercises the full discover, reserve, pay, and settle loop against a mock chain so you",
          "can see how a paid call works. Switch `BUYER_SDK_TRANSPORT` to `live` (and set a funded",
          "buyer key) to pay real endpoints.",
        ].join("\n");

  return [
    "---",
    `name: ${skillName}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${title}`,
    "",
    `${resource.description}`,
    "",
    "This is a paid Utter API. Agents discover it, pay per call in USDC on Arc, and receive the",
    "response only after payment. Payment is debited **only after the response passes validation**",
    "(the escrow response gate), so a bad answer costs nothing.",
    "",
    "## How to call it",
    "",
    `Use the tool **\`${tool}\`** exposed by this plugin's \`${MCP_SERVER_NAME}\` MCP server`,
    `(Claude lists it as \`${fqTool}\`).`,
    "",
    "- Input: the endpoint's request schema is derived from its OpenAPI. If it declares no request",
    "  body schema, pass your JSON payload under an `args` object.",
    "- The tool validates your input before paying (reject before pay), reserves the per-call cap,",
    "  runs the handler, validates the response, then settles exactly one debit of",
    "  `min(computed, cap)` split between the creator and the platform.",
    "- To browse related endpoints, use `utter_discover_endpoints`.",
    "",
    "## Price and reputation",
    "",
    `- Price: ${priceLine(resource)}.`,
    `- Cap: ${resource.pricing.max} USDC base units is the on-chain hard bound for a single call.`,
    `- Reputation: ${reputationLine(resource)}.`,
    `- resourceId: \`${resource.resourceId}\``,
    "",
    setup,
    "",
    "## Safety",
    "",
    "- The buyer key stays inside the local MCP process. It is never a tool argument, a tool return,",
    "  or a log line.",
    "- Per-call and per-day budget caps bound spend. A cap denial returns a tool error with no charge.",
    "",
    `Learn more at ${docsUrl}. Built by ${opts.ownerName ?? "Utter"} on ${opts.appUrl}.`,
    "",
  ].join("\n");
}

/** Render the base "Using Utter paid APIs" SKILL (discovery + call, escrow gate, budgets). */
export function renderBaseSkill(args: {
  opts: PluginGenOptions;
  mode: PluginMode;
  pluginName: string;
}): string {
  const { opts, mode, pluginName } = args;
  const docsUrl = "https://docs.utter.technology";
  const discover = `mcp__plugin_${pluginName}_${MCP_SERVER_NAME}__utter_discover_endpoints`;

  const description = clampDescription(
    "Discover and pay for Utter APIs from this agent. Use when you need a capability that a paid API " +
      "could provide (data, compute, a tool): list Utter endpoints with their price and reputation, then " +
      "call one and pay per call in USDC on Arc. Payment is gated on response validation, so a bad answer " +
      "costs nothing.",
  );

  const modeNote =
    mode === "live"
      ? [
          "This plugin runs the buyer in **live** mode. Configure `buyer_private_key` (a funded Arc",
          "buyer key) and `marketplace_url` before use. The live buyer path is operator-gated.",
        ].join("\n")
      : [
          "This plugin runs the buyer in **demo** mode: in-process, no real money, and nothing to",
          "configure. It runs the real discover, reserve, pay, and settle loop against a mock chain so",
          "you can see how paying for an API works. Switch `BUYER_SDK_TRANSPORT` to `live` and set a",
          "funded buyer key to pay real endpoints.",
        ].join("\n");

  return [
    "---",
    "name: using-utter",
    `description: ${yamlString(description)}`,
    "---",
    "",
    "# Using Utter paid APIs",
    "",
    "Utter turns a sentence into a live API that agents pay for per call in USDC on Arc. This plugin",
    "gives your agent the buyer tools to discover those APIs and pay for them autonomously, with no",
    "API keys and no humans in the loop.",
    "",
    "## The loop",
    "",
    `1. **Discover**: call \`utter_discover_endpoints\` (listed as \`${discover}\`), optionally with a`,
    "   `query`, to list endpoints with their price and reputation.",
    "2. **Call**: call the endpoint's `utter_call_<resourceId>` tool with arguments matching its",
    "   schema. The tool validates input before paying, reserves the cap, runs the handler, validates",
    "   the response, and settles exactly one debit of `min(computed, cap)`.",
    "3. **Only pay for good answers**: payment is debited only after the response passes validation",
    "   (the escrow response gate). A malfunction is not charged.",
    "",
    "## Budgets and safety",
    "",
    "- Per-call and per-day budget caps bound what any tool will spend. A denial returns a tool error",
    "  with no charge.",
    "- The buyer key is held inside the local MCP process. It is never a tool argument, a tool return,",
    "  or a log line.",
    "",
    "## Mode",
    "",
    modeNote,
    "",
    `Learn more at ${docsUrl}. Built by ${opts.ownerName ?? "Utter"}.`,
    "",
  ].join("\n");
}

/** The `/utter-buyer:discover` command body (a thin prompt that runs discovery). */
export function renderDiscoverCommand(): string {
  return [
    "---",
    'description: "List paid Utter API endpoints with their price and reputation."',
    'argument-hint: "[query]"',
    "---",
    "",
    "Call the `utter_discover_endpoints` tool" +
      " (pass `$ARGUMENTS` as the `query` when it is non-empty) and present the endpoints as a short",
    "table of name, price (USDC base units), and reputation. Then ask which one to call, or, if the",
    "user already named a task, pick the best-fit endpoint and call its `utter_call_<resourceId>` tool.",
    "",
  ].join("\n");
}

/** Render an endpoint plugin README. */
export function renderEndpointReadme(args: {
  resource: PluginResource;
  opts: PluginGenOptions;
  mode: PluginMode;
  pluginName: string;
  marketplaceName: string;
}): string {
  const { resource, mode, pluginName, marketplaceName } = args;
  const title = titleOf(resource);
  return [
    `# ${pluginName}`,
    "",
    `A Claude Code plugin for the Utter endpoint **${title}**.`,
    "",
    `> ${resource.description}`,
    "",
    "## Install",
    "",
    "```bash",
    `/plugin marketplace add Woshvad/utter`,
    `/plugin install ${pluginName}@${marketplaceName}`,
    "```",
    "",
    "Once enabled, this plugin's `utter-buyer` MCP server exposes the endpoint's call tool",
    `(\`${toolNameForResource(resource.resourceId)}\`) plus \`utter_discover_endpoints\`.`,
    "",
    "## Details",
    "",
    `- resourceId: \`${resource.resourceId}\``,
    `- Price: ${priceLine(resource)}`,
    `- Reputation: ${reputationLine(resource)}`,
    `- Mode: ${mode}`,
    "",
    "Payment flows through the Utter escrow response gate: you are charged only after the response",
    "passes validation. Learn more at https://docs.utter.technology.",
    "",
    "This file is generated by `@utter/plugin-gen`. Do not edit by hand; regenerate instead.",
    "",
  ].join("\n");
}

/** Render the base plugin README. */
export function renderBaseReadme(args: {
  opts: PluginGenOptions;
  mode: PluginMode;
  pluginName: string;
  marketplaceName: string;
}): string {
  const { mode, pluginName, marketplaceName } = args;
  return [
    `# ${pluginName}`,
    "",
    "The Utter buyer plugin: discover and pay for any Utter API from your agent.",
    "",
    "## Install",
    "",
    "```bash",
    `/plugin marketplace add Woshvad/utter`,
    `/plugin install ${pluginName}@${marketplaceName}`,
    "```",
    "",
    `This plugin bundles the Utter buyer MCP server (\`utter-buyer\`), which exposes`,
    "`utter_discover_endpoints` and one `utter_call_<resourceId>` tool per discovered endpoint.",
    "",
    `- Mode: ${mode}` + (mode === "demo" ? " (in-process, no real money, nothing to configure)" : " (operator-gated live path)"),
    "",
    "Payment flows through the Utter escrow response gate: you are charged only after the response",
    "passes validation. Learn more at https://docs.utter.technology.",
    "",
    "This file is generated by `@utter/plugin-gen`. Do not edit by hand; regenerate instead.",
    "",
  ].join("\n");
}
