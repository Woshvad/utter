// RequestBuilder - the STU-03 OpenAPI-driven request panel.
//
// A controlled, presentational component: it renders an HTTP method selector, one
// typed input per OpenAPI body field (string/number -> Input, boolean -> Toggle,
// enum -> a native select), and a raw-JSON toggle that swaps to the same textarea
// the playground has always used (data-testid="playground-request", aria-label
// "request body") so the power-user hand-edit path is preserved verbatim. It reports
// every change through its callbacks and NEVER calls onRun itself - the player owns
// the reserve-before-run seam. When the schema carries no fields the builder shows the
// raw textarea by default (the current behavior). This component touches the request
// body only; it renders no money.
import * as React from "react";
import { Input } from "../primitives/Input.js";
import type { ParamField, RequestSchema } from "./openapi-fields.js";

/** The shared token classes a native select borrows from the Input box variant. */
const SELECT_CLASS =
  "border border-hairline bg-raised px-xs py-2xs font-mono text-caption-mono lowercase text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue";

export interface RequestBuilderProps {
  /** The extracted request shape (methods + typed fields). */
  schema: RequestSchema;
  /** The selected HTTP method. */
  method: string;
  /** Report a method change. */
  onMethodChange: (method: string) => void;
  /** Whether the typed-field view or the raw-JSON view is showing. */
  mode: "form" | "raw";
  /** Report a view-mode change. */
  onModeChange: (mode: "form" | "raw") => void;
  /** The current typed-field values, keyed by field name (always strings). */
  values: Record<string, string>;
  /** Report a typed-field-values change. */
  onValuesChange: (values: Record<string, string>) => void;
  /** The raw-JSON body text (the fallback editor). */
  rawBody: string;
  /** Report a raw-JSON body change. */
  onRawBodyChange: (rawBody: string) => void;
}

export function RequestBuilder({
  schema,
  method,
  onMethodChange,
  mode,
  onModeChange,
  values,
  onValuesChange,
  rawBody,
  onRawBodyChange,
}: RequestBuilderProps): React.ReactElement {
  const hasFields = schema.fields.length > 0;
  // The typed-field view shows only when in form mode AND the schema has fields;
  // otherwise the raw textarea is the editor (the current behavior preserved).
  const showForm = mode === "form" && hasFields;

  const setValue = (field: ParamField, next: string) => {
    onValuesChange({ ...values, [field.name]: next });
  };

  return (
    <div className="flex flex-col gap-xs border border-hairline bg-raised">
      <div className="flex items-center justify-between border-b border-hairline px-sm py-2xs">
        <div className="flex items-center gap-xs">
          <span className="font-mono text-caption-mono text-ink-faint lowercase">request</span>
          {/* the method selector (native select, styled with the Input token classes) */}
          <select
            data-testid="playground-method"
            aria-label="http method"
            value={method}
            onChange={(e) => onMethodChange(e.target.value)}
            className={SELECT_CLASS}
          >
            {schema.methods.map((m) => (
              <option key={m} value={m}>
                {m.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        {/* the raw-JSON toggle (still works even with no fields). A native switch
            button carrying the testid the click target needs - same conventions as
            the Toggle primitive (square knob, hairline box, blue when pressed). */}
        <span className="inline-flex items-center gap-xs">
          <span className="text-label font-display text-ink lowercase">raw json</span>
          <button
            type="button"
            role="switch"
            aria-checked={mode === "raw"}
            aria-label="raw json"
            data-testid="playground-raw-toggle"
            data-pressed={mode === "raw"}
            onClick={() => onModeChange(mode === "raw" ? "form" : "raw")}
            className={[
              "relative inline-flex items-center h-5 w-9 border border-hairline cursor-pointer",
              mode === "raw" ? "bg-blue" : "bg-raised",
              "outline-none focus-visible:ring-2 focus-visible:ring-blue",
            ].join(" ")}
          >
            <span
              aria-hidden="true"
              className="absolute top-0.5 h-3.5 w-3.5 bg-ink transition-[left] duration-150"
              style={{ left: mode === "raw" ? "calc(100% - 1rem)" : "0.125rem" }}
            />
          </button>
        </span>
      </div>

      {showForm ? (
        <div className="flex flex-col gap-sm p-sm">
          {schema.fields.map((field) => (
            <label key={field.name} className="flex flex-col gap-2xs">
              <span className="font-mono text-caption-mono text-ink-muted lowercase">
                {field.name}
                {field.required ? " *" : ""}
              </span>
              {field.type === "boolean" ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={values[field.name] === "true"}
                  aria-label={field.name}
                  data-testid={`field-${field.name}`}
                  data-pressed={values[field.name] === "true"}
                  onClick={() => setValue(field, values[field.name] === "true" ? "false" : "true")}
                  className={[
                    "relative inline-flex items-center h-5 w-9 border border-hairline cursor-pointer self-start",
                    values[field.name] === "true" ? "bg-blue" : "bg-raised",
                    "outline-none focus-visible:ring-2 focus-visible:ring-blue",
                  ].join(" ")}
                >
                  <span
                    aria-hidden="true"
                    className="absolute top-0.5 h-3.5 w-3.5 bg-ink transition-[left] duration-150"
                    style={{ left: values[field.name] === "true" ? "calc(100% - 1rem)" : "0.125rem" }}
                  />
                </button>
              ) : field.type === "enum" ? (
                <select
                  data-testid={`field-${field.name}`}
                  aria-label={field.name}
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValue(field, e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">—</option>
                  {(field.enumValues ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  mono
                  data-testid={`field-${field.name}`}
                  aria-label={field.name}
                  inputMode={field.type === "number" ? "decimal" : undefined}
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValue(field, e.target.value)}
                  spellCheck={false}
                />
              )}
            </label>
          ))}
        </div>
      ) : (
        <textarea
          data-testid="playground-request"
          aria-label="request body"
          value={rawBody}
          onChange={(e) => onRawBodyChange(e.target.value)}
          spellCheck={false}
          rows={6}
          className="resize-y bg-canvas p-sm font-mono text-caption-mono leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
        />
      )}
    </div>
  );
}
