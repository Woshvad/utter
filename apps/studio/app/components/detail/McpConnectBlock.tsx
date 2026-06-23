// McpConnectBlock - "use from your agent" (UI-SPEC §Microcopy / §MCP connect block).
//
// COPYABLE CONFIG ONLY this phase. The reference paying-agent client + the MCP server are
// Phase 7 - this block renders a copyable JSON config (the resource's discovery card URL
// + the per-call escrow pay scheme) so an operator can wire it into their agent later. It
// performs NO payment and ships NO buyer client; it never derives money/identity (the
// card URL is the discovery source the agent reads everything else from).
//
// Layout (260623-726 comp 547-559): a right-rail framed block with an 11px blue-outline
// square + "use from your agent", a "mcp · paste into your config" caption, a config
// <pre>, and a full-width "connect via mcp" button -> /mcp (the mcp route lands in
// increment 9; the link may 404 until then).
import * as React from "react";

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

  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(config);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [config]);

  return (
    <div data-testid="mcp-connect" className="border border-hairline bg-raised p-[16px]">
      <div className="mb-[12px] flex items-center gap-[8px]">
        <span aria-hidden="true" className="h-[11px] w-[11px] border-2 border-blue" />
        <span className="text-[14px] font-semibold text-ink lowercase">use from your agent</span>
      </div>
      <div className="mb-[8px] flex items-center justify-between">
        <span className="font-mono text-[11px] text-ink-faint lowercase">
          mcp · paste into your config
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "copied" : "copy config"}
          className="font-mono text-[11px] text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-blue lowercase"
        >
          {copied ? "copied" : "copy config"}
        </button>
      </div>
      <pre
        data-testid="mcp-config"
        data-resource={resourceId}
        className="m-0 mb-[12px] overflow-auto border border-hairline bg-canvas p-[12px] font-mono text-[11px] leading-[1.6] text-ink-muted"
        style={{ whiteSpace: "pre-wrap" }}
      >
        {config}
      </pre>
      <a
        href="/mcp"
        data-testid="mcp-connect-link"
        className="block w-full bg-blue p-[10px] text-center font-mono text-[13px] text-white lowercase"
      >
        connect via mcp
      </a>
    </div>
  );
}
