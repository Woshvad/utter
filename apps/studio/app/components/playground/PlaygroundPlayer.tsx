// PlaygroundPlayer - the "watch-page hero" (UI-SPEC §Resource detail / Playground).
//
// The request builder (method + JSON params from the OpenAPI), the big triangle Run,
// and the split request/response (mono, line numbers, latency). Run calls the INJECTED
// `onRun` (which the screen wires to adapter.runPlayground) - in the fixture path that
// drives runTestEndpoint against an in-process createApp + mock chain, reusing the
// FROZEN requirePayment gate (reserve-before-run, T-06-FREECOMPUTE). The player NEVER
// calls a handler against an unreserved authorization: it has no fetch/handler of its
// own; the only call path is through the adapter seam.
//
// When the result reports an unfunded buyer (`paywall`), the PaywallSheet 402 beat slides
// in; paying re-runs through the same seam and streams the result. The metered price ticks
// via MeteredTicker (computeMeteredAmount, clamped to cap). Money renders only through
// UsdcAmount / the ticker (no 1e6/6 literal).
import * as React from "react";
import type { Pricing } from "@utter/x402-arc";
import type { AcceptsEntry } from "@utter/x402-arc";
import type { PlaygroundResult } from "../../adapter/types.js";
import { MeteredTicker } from "./MeteredTicker.js";
import { PaywallSheet } from "./PaywallSheet.js";
import { RequestBuilder } from "./RequestBuilder.js";
import { buildBody, type RequestSchema } from "./openapi-fields.js";

export interface PlaygroundPlayerProps {
  /** The resource being exercised. */
  resourceId: string;
  /** Decimals from a runtime read (the only scale source). */
  decimals: number;
  /** The metered pricing block (drives the ticker). */
  pricing: Pricing;
  /** The signed spend cap in base units (the hard ceiling). */
  cap: bigint;
  /**
   * Run the pay-flow for a request body. The screen wires this to adapter.runPlayground,
   * which reuses the frozen gate (reserve-before-run). A `paywall` in the result triggers
   * the 402 beat; a `funded` retry pays.
   */
  onRun: (req: unknown, opts?: { pay?: boolean }) => Promise<PlaygroundResult>;
  /** Whether the buyer has an escrow balance (controls the paywall pay copy). */
  funded?: boolean;
  /**
   * The OpenAPI-derived request shape (methods + typed fields). When it carries
   * fields the builder defaults to the typed form; otherwise (or when absent) the
   * raw-JSON editor is the default - the current behavior preserved.
   */
  requestSchema?: RequestSchema;
  /**
   * OPTIONAL client-side pay seam (260622-wlu). When provided, the PaywallSheet pay
   * triggers a connected-wallet signing of the escrow CAP authorization for the 402
   * quote (no key in the app) and submits it through the screen's submit seam, then
   * streams the result. When ABSENT (the existing tests + any caller that only wires
   * onRun), pay falls back to the current onRun({pay:true}) behavior so nothing
   * regresses. The browser only signs + submits the cap; the facilitator keeps
   * enforcing reserve-before-run + settle min(computed, cap) + exactly-once.
   */
  onPayWithWallet?: (quote: AcceptsEntry) => Promise<PlaygroundResult>;
}

type RunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "paywall"; quote: AcceptsEntry }
  | { phase: "done"; result: PlaygroundResult; latencyMs: number };

export function PlaygroundPlayer({
  resourceId,
  decimals,
  pricing,
  cap,
  onRun,
  funded = false,
  requestSchema,
  onPayWithWallet,
}: PlaygroundPlayerProps): React.ReactElement {
  const schema: RequestSchema = requestSchema ?? { methods: [], fields: [] };
  const hasFields = schema.fields.length > 0;
  const [method, setMethod] = React.useState(schema.methods[0] ?? "POST");
  // Default to the typed form only when the schema offers fields; otherwise the
  // raw-JSON editor is the default (the current behavior preserved).
  const [mode, setMode] = React.useState<"form" | "raw">(hasFields ? "form" : "raw");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [requestBody, setRequestBody] = React.useState('{\n  "text": "hello"\n}');
  const [state, setState] = React.useState<RunState>({ phase: "idle" });

  const doRun = React.useCallback(
    async (opts?: { pay?: boolean }) => {
      setState({ phase: "running" });
      const started =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      let parsed: unknown;
      if (mode === "form" && hasFields) {
        // Typed-field path: build the same plain object the raw editor would yield.
        parsed = buildBody(schema.fields, values);
      } else {
        try {
          parsed = JSON.parse(requestBody);
        } catch {
          parsed = requestBody;
        }
      }
      const result = await onRun(parsed, opts);
      const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
      const latencyMs = result.handlerMs ?? Math.max(0, Math.round(ended - started));

      if (!result.paid && result.paywall) {
        setState({ phase: "paywall", quote: result.paywall.quote as AcceptsEntry });
        return;
      }
      setState({ phase: "done", result, latencyMs });
    },
    [onRun, requestBody, mode, hasFields, schema.fields, values],
  );

  // Pay the 402 with the CONNECTED WALLET when the client pay seam is wired (260622-wlu):
  // sign the escrow CAP authorization for this paywall's quote in the wallet (popup, no
  // key in the app), submit it through the screen's seam, and stream the result into the
  // `done` phase. When the seam is ABSENT, fall back to the current onRun({pay:true})
  // server path so the existing tests + callers do not regress. The browser only signs +
  // submits a cap; the facilitator keeps the gate + reserve-before-run server-side.
  const onPay = React.useCallback(
    (quote: AcceptsEntry) => {
      if (!onPayWithWallet) {
        void doRun({ pay: true });
        return;
      }
      void (async () => {
        setState({ phase: "running" });
        const started =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        try {
          const result = await onPayWithWallet(quote);
          const ended =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          const latencyMs =
            result.handlerMs ?? Math.max(0, Math.round(ended - started));
          if (!result.paid && result.paywall) {
            setState({ phase: "paywall", quote: result.paywall.quote as AcceptsEntry });
            return;
          }
          setState({ phase: "done", result, latencyMs });
        } catch {
          // Keep the paywall up so the buyer can retry (the wallet may have been
          // rejected or the submission failed). No error detail is surfaced here.
          setState({ phase: "paywall", quote });
        }
      })();
    },
    [onPayWithWallet, doRun],
  );

  return (
    <div className="flex flex-col gap-md" data-testid="playground-player" data-resource={resourceId}>
      {/* request builder + the split request/response */}
      <div className="grid grid-cols-1 gap-md lg:grid-cols-2">
        {/* request side: the OpenAPI-driven builder (method + typed fields + raw toggle) */}
        <RequestBuilder
          schema={schema}
          method={method}
          onMethodChange={setMethod}
          mode={mode}
          onModeChange={setMode}
          values={values}
          onValuesChange={setValues}
          rawBody={requestBody}
          onRawBodyChange={setRequestBody}
        />

        {/* response side */}
        <div className="flex flex-col gap-xs border border-hairline bg-raised">
          <div className="flex items-center justify-between border-b border-hairline px-sm py-2xs">
            <span className="font-mono text-caption-mono text-ink-faint lowercase">response</span>
            {state.phase === "done" ? (
              <span className="font-mono text-caption-mono text-ink-muted tabular-nums lowercase">
                {`${state.latencyMs}ms`}
              </span>
            ) : null}
          </div>
          <pre
            data-testid="playground-response"
            className="min-h-[8rem] overflow-x-auto p-sm font-mono text-caption-mono leading-relaxed text-ink"
          >
            {state.phase === "running"
              ? "running…"
              : state.phase === "done"
                ? JSON.stringify(state.result.body, null, 2)
                : ""}
          </pre>
          {/* metered ticking, shown once a paid result returns */}
          {state.phase === "done" && state.result.paid ? (
            <div className="border-t border-hairline px-sm py-2xs">
              <MeteredTicker
                pricing={pricing}
                cap={cap}
                decimals={decimals}
                bodyBytes={state.result.bodyBytes ?? 0}
                handlerMs={state.result.handlerMs ?? state.latencyMs}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* the big triangle Run control (red, the product's "play") */}
      <button
        type="button"
        data-testid="playground-run"
        onClick={() => void doRun()}
        disabled={state.phase === "running"}
        className="inline-flex min-h-[44px] items-center gap-sm self-start border border-red bg-red px-lg py-xs font-display text-label text-paper lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-60"
      >
        <span
          aria-hidden="true"
          style={{
            width: 0,
            height: 0,
            borderTop: "7px solid transparent",
            borderBottom: "7px solid transparent",
            borderLeft: "12px solid var(--paper)",
          }}
        />
        run
      </button>

      {/* the 402 paywall beat slides in when the buyer is unfunded */}
      {state.phase === "paywall" ? (
        <PaywallSheet
          quote={state.quote}
          decimals={decimals}
          funded={funded}
          onPay={() => onPay(state.quote)}
        />
      ) : null}
    </div>
  );
}
