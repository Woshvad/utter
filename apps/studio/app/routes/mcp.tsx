// mcp.tsx - the buyer-facing MCP-connect screen (comp Design/Utter.dc.html 742-803).
//
// PUBLIC screen (no requireCreator) rendered INSIDE the app shell <main>. It is the
// "connect utter to your agent" surface: it shows the two copy-paste snippets a buyer
// needs (the mcp server config + the buyer-sdk call) and a short honest pointer to where
// real per-agent activity shows up. The snippets are copy-paste TEMPLATES: the wallet is
// an obvious placeholder the buyer fills in, and the daily cap is a documented default
// they edit - not fabricated live data. There is NO fake "recent paid calls" feed or live
// spend-cap meter on this public page (there is no buyer-side data source here); a
// connected agent's real calls + caps surface in the buyer's own wallet.
//
// Triad discipline: this buyer screen LEADS BLUE (identity / info / links). No money is
// rendered live here, so there is no 1e6/6 literal anywhere; if real money is ever wired
// here it must go through UsdcAmount at runtime decimals.
//
// SSR safety: navigator.clipboard is touched ONLY inside the copy button's onClick
// handler, never during render, so the screen renders server-side without a crash.
import * as React from "react";
import { Link } from "react-router";

/** The mcp server config snippet: a copy-paste TEMPLATE. `wallet` is a placeholder the
 *  buyer replaces with their own address; `daily` is a documented default cap they edit. */
const MCP_CONFIG_SNIPPET = `{
  "mcpServers": {
    "utter": {
      "url": "https://mcp.utter.sh",
      "wallet": "0xYOUR_WALLET_ADDRESS",
      "caps": { "daily": "$5.00" }
    }
  }
}`;

/** The buyer-sdk call snippet (a copy-paste template). */
const BUYER_SDK_SNIPPET = `import { Utter } from "utter-sdk"

const u = new Utter({ wallet })
const r = await u.call(
  "sentiment-score",
  { text },
  { maxPrice: "$0.0042" }
)`;

/** A copy-paste code card matching the comp (header label + a working copy button,
 *  then a whitespace-pre-wrap <pre> body). The copy lives in an event handler so the
 *  card renders server-side without touching navigator. */
function CodeCard({ label, code }: { label: string; code: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(code);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [code]);

  return (
    <div className="border border-hairline bg-raised">
      <div className="flex items-center justify-between border-b border-hairline p-[14px_16px]">
        <span className="font-mono text-[12px] text-ink-faint">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "copied" : `copy ${label}`}
          className="cursor-pointer font-mono text-[12px] text-blue outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="m-0 whitespace-pre-wrap p-[18px_16px] font-mono text-[12px] leading-[1.7] text-ink-muted">
        {code}
      </pre>
    </div>
  );
}

export default function McpConnectRoute(): React.ReactElement {
  return (
    <div className="max-w-[1100px] px-[32px] pt-[28px] pb-[64px]">
      {/* header: blue-outline square + h1 (comp 745-748) */}
      <div className="mb-[8px] flex items-center gap-[12px]">
        <div className="h-[14px] w-[14px] border-2 border-blue" aria-hidden="true" />
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em]">
          connect utter to your agent
        </h1>
      </div>
      <p className="mb-[28px] max-w-[560px] text-[15px] text-ink-muted">
        expose every api on utter as a paid tool to your agent over mcp. it discovers,
        pays, and calls autonomously within your caps.
      </p>

      {/* top grid: two copy-paste code cards (comp 751-781) */}
      <div className="mb-[16px] grid grid-cols-2 gap-[16px]">
        <CodeCard label="mcp config" code={MCP_CONFIG_SNIPPET} />
        <CodeCard label="buyer sdk" code={BUYER_SDK_SNIPPET} />
      </div>

      {/* honest pointer: there is no buyer-side feed on this public page. A connected
          agent's real paid calls + spend caps surface in the buyer's own wallet. */}
      <div className="border border-hairline bg-raised p-[20px]">
        <p className="m-0 text-[14px] text-ink-muted">
          once your agent is connected, its paid calls and spend caps show up in your{" "}
          <Link to="/wallet" className="text-blue hover:underline">
            wallet
          </Link>
          .
        </p>
      </div>

      {/* keep /keys reachable now that the nav shows "mcp connect" instead of keys */}
      <div className="mt-[24px]">
        <Link to="/keys" className="font-mono text-[13px] text-blue hover:underline">
          manage api keys →
        </Link>
      </div>
    </div>
  );
}
