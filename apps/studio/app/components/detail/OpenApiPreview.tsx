// OpenApiPreview - the generated OpenAPI preview (mono). Two modes:
//
//   1. JSON mode (resource detail STU-03): given an `openapi` doc (object or raw
//      string), render it in the single mono CodeBlock surface; read-through only
//      (never re-authored).
//   2. Snippet mode (create aside): given a `snippet` string, render a plain <pre>
//      (no line numbers) styled per the comp (Design/Utter.dc.html 357-358).
import * as React from "react";
import { CodeBlock } from "../primitives/CodeBlock";

/** The comp's sample openapi snippet (data line 965), the create-aside default. */
const DEFAULT_SNIPPET =
  "POST /v1/score\n  body:\n    text: string\n  200:\n    score: number  // -1..1\n    label: string\n    confidence: number";

export interface OpenApiPreviewProps {
  /** The OpenAPI doc - a parsed object or a raw JSON/YAML string (JSON mode). */
  openapi?: unknown;
  caption?: string;
  /** Snippet-mode plain-text preview (the create aside). */
  snippet?: string;
}

export function OpenApiPreview({ openapi, caption, snippet }: OpenApiPreviewProps): React.ReactElement {
  // Snippet mode: a plain comp-styled <pre> (create aside).
  if (snippet !== undefined || openapi === undefined) {
    return (
      <pre
        data-testid="openapi-preview"
        className="m-0 overflow-auto whitespace-pre-wrap border border-hairline bg-raised p-[14px] font-mono text-[11.5px] leading-[1.6] text-ink-muted"
      >
        {snippet ?? DEFAULT_SNIPPET}
      </pre>
    );
  }

  // JSON mode: the mono CodeBlock projection (resource detail).
  const code = typeof openapi === "string" ? openapi : JSON.stringify(openapi, null, 2);
  return (
    <div data-testid="openapi-preview" className="flex flex-col gap-2xs">
      <CodeBlock code={code} caption={caption ?? "openapi.json"} />
    </div>
  );
}
