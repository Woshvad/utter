// mcp.tsx - the buyer-facing MCP-connect screen (comp Design/Utter.dc.html 742-803).
//
// PUBLIC screen (no requireCreator) rendered INSIDE the app shell <main>. It is the
// "connect utter to your agent" surface: it shows the two copy-paste snippets a buyer
// needs (the mcp server config + the buyer-sdk call), a recent-paid-calls feed, and a
// spend-cap card. The sidebar already carries an "mcp connect" nav item -> /mcp;
// registering this route makes it resolve (no more 404).
//
// Triad discipline: this buyer screen LEADS BLUE (identity / info / links); the money
// (the spend cap) is the lone YELLOW accent. The recent-paid-calls rows, the config
// values, and the spend-cap figures are REPRESENTATIVE sample data (deterministic,
// clearly fixture) - there is no real buyer-side feed wired here yet. The spend-cap
// "$5.00" / "$1.24" are representative caps, not a live money read, so they are plain
// strings (no 1e6/6 literal anywhere; if real money is ever wired here it must go
// through UsdcAmount at runtime decimals).
//
// SSR safety: navigator.clipboard is touched ONLY inside the copy button's onClick
// handler, never during render, so the screen renders server-side without a crash.
import * as React from "react";
import { Link } from "react-router";

/** The mcp server config snippet (representative values, comp 757-765). */
const MCP_CONFIG_SNIPPET = `{
  "mcpServers": {
    "utter": {
      "url": "https://mcp.utter.sh",
      "wallet": "0x4f2a…91c0",
      "caps": { "daily": "$5.00" }
    }
  }
}`;

/** The buyer-sdk call snippet (representative, comp 772-779). */
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

/** A recent-paid-call row: a triangle glyph + label + tx hash + amount (comp 787-792).
 *  Representative sample data (deterministic; clearly fixture). */
interface PaidCall {
  label: string;
  hash: string;
  amt: string;
  /** The amount color token class - blue for info rows, yellow for the money emphasis. */
  amtClass: string;
}

const RECENT_PAID_CALLS: readonly PaidCall[] = [
  { label: "sentiment-score", hash: "0x91c0…7af2", amt: "$0.0042", amtClass: "text-ink" },
  { label: "geocode-address", hash: "0x4f2a…11b8", amt: "$0.0018", amtClass: "text-ink" },
  { label: "summarize-doc", hash: "0xa3d1…9e04", amt: "$0.0090", amtClass: "text-ink" },
  { label: "fx-rate-usdc", hash: "0x77c5…2d10", amt: "$0.0006", amtClass: "text-ink" },
];

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

      {/* bottom grid: recent paid calls (1.4fr) + spend cap (1fr) (comp 783-802) */}
      <div className="grid grid-cols-[1.4fr_1fr] gap-[16px]">
        {/* RECENT PAID CALLS (comp 784-794) */}
        <div className="border border-hairline bg-raised">
          <div className="border-b border-hairline p-[16px_18px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
            RECENT PAID CALLS
          </div>
          {RECENT_PAID_CALLS.map((tx) => (
            <div
              key={tx.hash}
              className="flex items-center gap-[14px] border-b border-hairline p-[13px_18px]"
            >
              {/* triangle glyph (comp 788) */}
              <div
                aria-hidden="true"
                className="h-0 w-0 flex-none border-y-[6px] border-l-[10px] border-y-transparent border-l-ink-faint"
              />
              <span className="flex-1 text-[13px]">{tx.label}</span>
              <span className="font-mono text-[12px] text-blue">{tx.hash}</span>
              <span className={`font-mono text-[13px] font-bold ${tx.amtClass}`}>{tx.amt}</span>
            </div>
          ))}
        </div>

        {/* SPEND CAP (comp 795-801) - the lone YELLOW money accent */}
        <div className="border border-hairline bg-raised p-[20px]">
          <div className="mb-[16px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
            SPEND CAP
          </div>
          <div className="mb-[4px] font-mono text-[36px] font-bold text-yellow">$5.00</div>
          <div className="mb-[18px] font-mono text-[12px] text-ink-muted">
            per day · $1.24 used
          </div>
          {/* 6px progress bar with a 25% blue fill (comp 799) */}
          <div className="mb-[18px] h-[6px] border border-hairline bg-canvas">
            <div className="h-full w-[25%] bg-blue" />
          </div>
          <Link
            to="/wallet"
            className="block w-full bg-blue p-[12px] text-center font-mono text-[14px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            manage caps
          </Link>
        </div>
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
