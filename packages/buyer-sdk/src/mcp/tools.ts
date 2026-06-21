// tools.ts - the MCP tool builders (BUY-02). GREENFIELD (no repo analog; follows
// RESEARCH Pattern 4 + Open Question 1).
//
//   buildDiscoveryTool(cardSource): a tool that lists/searches discovered Utter resources,
//     projecting ONLY price + reputation + bond to the model (NEVER a key).
//   buildEndpointTool(card, payFn): a per-endpoint call tool whose:
//     - inputSchema is DERIVED from the resource openapi.json request schema (a zod raw
//       shape; per Open Q1 the simplest no-new-dep path is a server-side-validated
//       passthrough - we build a concrete shape from the openapi properties when present
//       and fall back to a passthrough record). The handler RE-VALIDATES args against the
//       openapi BEFORE pay (reject-before-pay, V5 / T-07-INPUTVAL).
//     - title/description surface PRICE (from card.pricing) + REPUTATION (verified flag +
//       agentId) read from the card.
//     - the HANDLER calls payFn (the client pay-flow). The buyer key is held in the client
//       closure - it is NEVER a field of the tool config, an arg, or the return (BUY-03 /
//       T-07-KEYLEAK).
//
// NO stdout writes anywhere in this file (stdout is the JSON-RPC channel - Pitfall 1).
import { z } from "zod";

/** The price block surfaced per tool (base units, strings - never scaled with a literal). */
export interface DiscoveredPricing {
  /** The pricing model (metered/flat). */
  model: string;
  /** The base charge per call (base units, string). */
  base: string;
  /** The per-KB charge (base units, string). */
  perKB: string;
  /** The escrow max / cap (base units, string). */
  max: string;
}

/** A discovered resource card projection (price + reputation + the openapi). NO key. */
export interface DiscoveredCard {
  /** The resourceId (bytes32) the pay flow targets. */
  resourceId: string;
  /** A human title for the tool. */
  name: string;
  /** The escrow contract address (from the validated card). */
  escrow: string;
  /** The USDC asset address (from the validated card). */
  asset: string;
  /** The payTo (resourceId) the debit authorization is signed over. */
  payTo: string;
  /** The metered pricing block surfaced in the tool description. */
  pricing: DiscoveredPricing;
  /** The cap (escrow max) in base units - the on-chain hard bound for the call. */
  capBaseUnits: bigint;
  /** The reputation/health verified flag. */
  verified: boolean;
  /** The ERC-8004 agentId (reputation identity). */
  agentId: string;
  /** Whether a bond is posted. */
  bondPosted: boolean;
  /** The resource openapi.json the inputSchema derives from. */
  openapi: Record<string, unknown>;
}

/** Resolve the discoverable resource cards (fixture in tests; live marketplace operator-gated). */
export type CardListSource = (query?: string) => Promise<DiscoveredCard[]>;

/** What a tool handler returns (the MCP content envelope; isError flags a tool error). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The pay function the endpoint tool's handler calls (the client pay-flow, key server-side). */
export type PayFn = (req: {
  resource: { resourceId: string };
  body: unknown;
}) => Promise<{ response: string; debitAmount: bigint }>;

/**
 * An optional pre-pay guard the endpoint handler runs AFTER input validation and BEFORE
 * pay (the budget guard wires this). Return a deny reason string to block the call (a
 * tool error, NO pay), or null to allow. NEVER carries key material.
 */
export type PrePayGuard = () => { ok: true } | { ok: false; reason: string };

/**
 * An optional RESERVE-before-pay budget lifecycle (WR-02). When supplied it SUPERSEDES the
 * `prePay` check: the handler `reserve()`s the projected spend BEFORE pay (atomically, so
 * concurrent tool calls cannot collectively overshoot the cap), then `commit(handle,
 * actualDebit)` on a successful pay or `release(handle)` on a pay failure. The handle `H`
 * is opaque to the tool layer (the budget module owns its shape). NEVER carries key
 * material.
 */
export interface BudgetLifecycle<H = unknown> {
  /** Atomically reserve the projected spend; a live handle or a typed deny. */
  reserve(): { ok: true; handle: H } | { ok: false; reason: string };
  /** Commit the reservation to the ACTUAL settled debit (after a successful pay). */
  commit(handle: H, actualAmount: bigint): void;
  /** Release the reservation (after a pay failure) so no budget room leaks. */
  release(handle: H): void;
}

/** A built tool: its registration name + config + an in-process handler (tests drive this). */
export interface BuiltTool {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** A built discovery tool. */
export interface BuiltDiscoveryTool {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  };
  handler: (args: { query?: string }) => Promise<ToolResult>;
}

/** A tool-error result (NEVER carries key material - the message is the validation reason). */
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Locate the JSON request schema in the resource openapi (POST /call requestBody). */
function openapiRequestSchema(openapi: Record<string, unknown>): Record<string, unknown> | null {
  const paths = (openapi.paths as Record<string, unknown> | undefined) ?? {};
  for (const pathItem of Object.values(paths)) {
    const ops = pathItem as Record<string, unknown>;
    for (const method of ["post", "put", "patch", "get"]) {
      const op = ops[method] as Record<string, unknown> | undefined;
      const body = op?.requestBody as Record<string, unknown> | undefined;
      const content = body?.content as Record<string, unknown> | undefined;
      const json = content?.["application/json"] as Record<string, unknown> | undefined;
      const schema = json?.schema as Record<string, unknown> | undefined;
      if (schema) return schema;
    }
  }
  return null;
}

/**
 * Derive the MCP inputSchema (a zod raw shape) from the openapi request schema. Per
 * Open Q1 this is the simplest no-new-dep path: map the top-level openapi properties to
 * loose zod schemas (the handler RE-VALIDATES against the full openapi server-side before
 * pay). When the openapi carries no usable request schema we fall back to a passthrough
 * single `args` record so the tool still registers; the handler still validates.
 */
function deriveInputShape(openapi: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const schema = openapiRequestSchema(openapi);
  const props = (schema?.properties as Record<string, unknown> | undefined) ?? null;
  if (!props || Object.keys(props).length === 0) {
    // Passthrough fallback (Open Q1): a single opaque record, validated server-side.
    return { args: z.record(z.string(), z.unknown()) };
  }
  const required = new Set(
    Array.isArray(schema?.required) ? (schema!.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(props)) {
    const t = (raw as { type?: string }).type;
    let leaf: z.ZodTypeAny;
    switch (t) {
      case "string":
        leaf = z.string();
        break;
      case "integer":
      case "number":
        leaf = z.number();
        break;
      case "boolean":
        leaf = z.boolean();
        break;
      case "array":
        leaf = z.array(z.unknown());
        break;
      case "object":
        leaf = z.record(z.string(), z.unknown());
        break;
      default:
        leaf = z.unknown();
    }
    shape[key] = required.has(key) ? leaf : leaf.optional();
  }
  return shape;
}

/**
 * Validate the model-supplied args against the openapi request schema (the SERVER-SIDE
 * gate, reject-before-pay / V5). Returns null on OK, or an error message string. We do a
 * pragmatic structural check (required keys present, no unknown keys when
 * additionalProperties:false) - the openapi is the buyer's own contract for the call body.
 */
function validateArgsAgainstOpenapi(
  openapi: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  const schema = openapiRequestSchema(openapi);
  if (!schema) return null; // no schema -> nothing to validate against (passthrough)
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `input validation failed: missing required field "${key}"`;
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) {
        return `input validation failed: unexpected field "${key}"`;
      }
    }
  }
  return null;
}

/** Human price string surfaced to the model (base-unit values, NO decimals literal). */
function priceLine(card: DiscoveredCard): string {
  const p = card.pricing;
  return `Price: base ${p.base} + ${p.perKB}/KB ${p.model} USDC base-units per call, cap ${p.max} (the on-chain hard bound).`;
}

/** Reputation string surfaced to the model. */
function reputationLine(card: DiscoveredCard): string {
  return `Reputation: ${card.verified ? "verified" : "unverified"}, agentId ${card.agentId}, bond ${card.bondPosted ? "posted" : "none"}.`;
}

/**
 * A stable, MCP-safe, COLLISION-RESISTANT tool name from a resourceId (WR-01). We use the
 * FULL 32-byte resourceId (64 hex chars), not a truncated 8-char prefix: an 8-hex prefix
 * is only the first 4 bytes of a 32-byte id, so two distinct resources sharing that prefix
 * collide and (in registerOne) the second is silently dropped. The full id is unique, so
 * distinct resources always get distinct tool names. Sanitized to the MCP-safe charset
 * (lowercase hex) and exported so the server's collision check + tests share one derivation.
 */
export function endpointToolName(card: DiscoveredCard): string {
  const full = card.resourceId.replace(/^0x/, "").toLowerCase();
  return `utter_call_${full}`;
}

/**
 * Build a per-endpoint call tool. The config surfaces price + reputation; the inputSchema
 * is derived from the resource openapi; the handler validates args server-side (V5) then
 * calls payFn (the client pay-flow - the buyer key is in the client closure, never here).
 */
export function buildEndpointTool(
  card: DiscoveredCard,
  payFn: PayFn,
  prePay?: PrePayGuard,
  lifecycle?: BudgetLifecycle,
): BuiltTool {
  const inputSchema = deriveInputShape(card.openapi);
  // WR-04: when the resource ships no usable request schema, deriveInputShape returns the
  // passthrough envelope `{ args: <record> }`, so the model is instructed to pass
  // `{ args: {...} }`. The handler MUST unwrap that envelope before paying, otherwise the
  // raw `{ args: {...} }` wrapper is POSTed as the body and a schemaless seller handler
  // gets a double-wrapped payload. We detect the passthrough case from the derived shape
  // (a single `args` key) so the schema and the forwarded body agree in both cases.
  const isPassthrough =
    Object.keys(inputSchema).length === 1 && Object.prototype.hasOwnProperty.call(inputSchema, "args");
  return {
    name: endpointToolName(card),
    config: {
      title: card.name,
      description: `${card.name}. ${priceLine(card)} ${reputationLine(card)}`,
      inputSchema,
      annotations: { idempotentHint: true, readOnlyHint: false },
    },
    async handler(args: Record<string, unknown>): Promise<ToolResult> {
      // V5 reject-before-pay: validate the model args against the openapi BEFORE any pay.
      const err = validateArgsAgainstOpenapi(card.openapi, args ?? {});
      if (err) return toolError(err);

      // Budget pre-flight (T-07-DENIALOFWALLET). WR-02: when a reserve-before-pay lifecycle
      // is wired, RESERVE the projected spend atomically BEFORE pay (a per-invocation
      // handle, so concurrent calls cannot collectively overshoot the cap), then commit the
      // actual debit on success / release on failure. The reservation handle is local to
      // THIS invocation (never shared across concurrent calls). When only the legacy
      // `prePay` check is wired, fall back to the (non-reserving) check.
      let held: { ok: true; handle: unknown } | null = null;
      if (lifecycle) {
        const r = lifecycle.reserve();
        if (!r.ok) return toolError(r.reason);
        held = r;
      } else if (prePay) {
        const decision = prePay();
        if (!decision.ok) return toolError(decision.reason);
      }

      // WR-04: for the passthrough envelope unwrap the inner `args` payload so the body
      // POSTed to the seller is the intended `{...}`, not a double-wrapped `{ args: {...} }`.
      // The schema-derived (property) case forwards the validated args object directly.
      const body =
        isPassthrough && args && typeof args.args === "object" && args.args !== null
          ? args.args
          : args;

      let result: { response: string; debitAmount: bigint };
      try {
        result = await payFn({ resource: { resourceId: card.resourceId }, body });
      } catch (e) {
        // Pay failed/reverted: RELEASE the reservation so no budget room leaks (WR-02/WR-03).
        if (held && lifecycle) lifecycle.release(held.handle);
        throw e;
      }
      // Settled: COMMIT the reservation to the ACTUAL debit (reconciles the cap-basis
      // reservation down to the metered amount - check and record now share one basis).
      if (held && lifecycle) lifecycle.commit(held.handle, result.debitAmount);
      return { content: [{ type: "text", text: result.response }] };
    },
  };
}

/**
 * Build the discovery tool. It lists/searches discoverable resources, projecting ONLY
 * price + reputation + bond to the model (NEVER a key). The card source is injected (a
 * fixture in tests; the live marketplace read is operator-gated).
 */
export function buildDiscoveryTool(cardSource: CardListSource): BuiltDiscoveryTool {
  return {
    name: "utter_discover_endpoints",
    config: {
      title: "Discover Utter endpoints",
      description:
        "List or search paid Utter API endpoints. Returns each endpoint's price (base units) and reputation (verified flag + agentId). Pass an optional `query` to filter.",
      inputSchema: { query: z.string().optional() },
    },
    async handler(args: { query?: string }): Promise<ToolResult> {
      const cards = await cardSource(args?.query);
      if (cards.length === 0) {
        return { content: [{ type: "text", text: "No matching Utter endpoints found." }] };
      }
      const lines = cards.map((c) => {
        return [
          `- ${c.name} [${endpointToolName(c)}]`,
          `  ${priceLine(c)}`,
          `  ${reputationLine(c)}`,
        ].join("\n");
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}
