// CodeBlock - mono code panel with optional line numbers + a copy button. Used for
// the generated OpenAPI / agent-card preview and the MCP-connect config block. All
// code renders in JetBrains Mono (the mono discipline). No syntax-highlight library
// (the brief wants flat, hard-edged code, not a rainbow theme).
import * as React from "react";

export interface CodeBlockProps {
  code: string;
  /** Render gutter line numbers (default true). */
  lineNumbers?: boolean;
  /** Show the copy button (default true). */
  copyable?: boolean;
  /** A small caption / filename above the block. */
  caption?: string;
  className?: string;
}

export function CodeBlock({
  code,
  lineNumbers = true,
  copyable = true,
  caption,
  className,
}: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const lines = code.replace(/\n$/, "").split("\n");

  const onCopy = React.useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(code);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [code]);

  return (
    <div
      data-testid="code-block"
      className={["border border-hairline bg-raised", className].filter(Boolean).join(" ")}
    >
      {(caption || copyable) && (
        <div className="flex items-center justify-between border-b border-hairline px-sm py-2xs">
          <span className="font-mono text-caption-mono text-ink-faint lowercase">
            {caption ?? ""}
          </span>
          {copyable ? (
            <button
              type="button"
              onClick={onCopy}
              className="font-mono text-caption-mono text-ink-muted hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue lowercase"
              aria-label={copied ? "copied" : "copy code"}
            >
              {copied ? "copied" : "copy"}
            </button>
          ) : null}
        </div>
      )}
      <pre className="overflow-x-auto p-sm font-mono text-caption-mono leading-relaxed text-ink">
        <code>
          {lines.map((line, i) => (
            <div key={i} className="flex">
              {lineNumbers ? (
                <span
                  aria-hidden="true"
                  className="mr-sm select-none text-right text-ink-faint"
                  style={{ minWidth: "2ch" }}
                >
                  {i + 1}
                </span>
              ) : null}
              <span className="whitespace-pre">{line || " "}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
