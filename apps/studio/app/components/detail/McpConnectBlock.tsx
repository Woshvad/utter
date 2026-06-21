// McpConnectBlock - "use from your agent" (UI-SPEC §Microcopy / §MCP connect block).
//
// COPYABLE CONFIG ONLY this phase. The reference paying-agent client + the MCP server are
// Phase 7 - this block renders a copyable JSON config (the resource's discovery card URL
// + the per-call escrow pay scheme) so an operator can wire it into their agent later. It
// performs NO payment and ships NO buyer client; it never derives money/identity (the
// card URL is the discovery source the agent reads everything else from).
import * as React from "react";
import { CodeBlock } from "../primitives/CodeBlock.js";

export interface McpConnectBlockProps {
  /** The resource being connected (the mcp server entry name). */
  resourceId: string;
  /** The resource's agent-card URL (the SOLE discovery source the agent reads). */
  cardUrl: string;
}

export function McpConnectBlock({
  resourceId,
  cardUrl,
}: McpConnectBlockProps): React.ReactElement {
  // A copyable config block: the discovery card URL + the x402 escrow pay scheme the
  // (Phase-7) agent client will use. This is a template only - no client is shipped here.
  const config = JSON.stringify(
    {
      mcpServers: {
        utter: {
          // The agent discovers + pays per call by reading this card (Phase 7 client).
          card: cardUrl,
          pay: { scheme: "utter-escrow", network: "eip155:5042002" },
        },
      },
    },
    null,
    2,
  );

  return (
    <div data-testid="mcp-connect" className="flex flex-col gap-sm">
      <h3 className="font-display text-heading text-ink lowercase">use from your agent</h3>
      <p className="text-body text-ink-muted lowercase">
        copy this config. your agent deposits usdc once, then discovers + pays per call. no
        api keys, no humans. (the reference agent client ships next phase.)
      </p>
      <div data-testid="mcp-config" data-resource={resourceId}>
        <CodeBlock code={config} caption="mcp config" copyable />
      </div>
      {/* an explicit copy-config affordance label (the CodeBlock copy button copies it) */}
      <span className="font-mono text-caption-mono text-ink-faint lowercase">copy config</span>
    </div>
  );
}
