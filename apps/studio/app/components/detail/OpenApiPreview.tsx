// OpenApiPreview - the generated OpenAPI preview (mono). Renders the OpenAPI doc the
// adapter projects; read-through only (never re-authored). Shown in the single mono
// CodeBlock surface. Accepts either a parsed object or a raw string.
import * as React from "react";
import { CodeBlock } from "../primitives/CodeBlock";

export interface OpenApiPreviewProps {
  /** The OpenAPI doc - a parsed object or a raw JSON/YAML string. */
  openapi: unknown;
  caption?: string;
}

export function OpenApiPreview({ openapi, caption }: OpenApiPreviewProps): React.ReactElement {
  const code =
    typeof openapi === "string" ? openapi : JSON.stringify(openapi, null, 2);
  return (
    <div data-testid="openapi-preview" className="flex flex-col gap-2xs">
      <CodeBlock code={code} caption={caption ?? "openapi.json"} />
    </div>
  );
}
