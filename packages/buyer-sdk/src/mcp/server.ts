// server.ts - createMcpServer (BUY-02 / BUY-03). GREENFIELD (first MCP server in repo;
// follows RESEARCH Pattern 4 + the verified @modelcontextprotocol/sdk@1.29.0 subpaths).
//
// createMcpServer({ client, cardSource, budget }) builds an McpServer (imported from the
// A1-verified subpath @modelcontextprotocol/sdk/server/mcp.js), registers a DISCOVERY
// tool + per-endpoint CALL tools via registerTool, and returns the server plus an
// in-process drive surface (toolNames + invoke) so tests exercise the handlers WITHOUT a
// real stdio pipe or a live model.
//
// Each endpoint handler, in order:
//   (1) validate the model args against the resource openapi (reject-before-pay, V5 -
//       inside buildEndpointTool.handler),
//   (2) the budget pre-pay guard (budget.check) - a DENY returns a tool-error result, NO
//       pay, NO key in the message (T-07-DENIALOFWALLET),
//   (3) client.pay({ resource, body }) - the buyer key is held in the CLIENT closure,
//       NEVER a handler arg/return (T-07-KEYLEAK),
//   (4) budget.record(tool, debitAmount) after the settled debit.
//
// The buyer key NEVER appears in a tool arg, a tool return, or a log line. NO stdout
// writes anywhere in this file - stdout is the JSON-RPC channel (Pitfall 1 / T-07-STDOUT).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BudgetGuard } from "./budget.js";
import {
  buildDiscoveryTool,
  buildEndpointTool,
  type BuiltTool,
  type CardListSource,
  type DiscoveredCard,
  type ToolResult,
} from "./tools.js";

/**
 * The minimal buyer-client surface the MCP server depends on (the key is in ITS closure).
 * `pay` may return any superset of { response, debitAmount } - the createBuyerClient
 * PayResult satisfies this structurally (extra fields like cap/idemKey/receipt are fine).
 */
export interface McpBuyerClient {
  pay(req: {
    resource: { resourceId: string };
    body: unknown;
  }): Promise<{ response: string; debitAmount: bigint }>;
}

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions {
  /** The buyer client whose pay-flow the tools wrap (holds the key in its closure). */
  client: McpBuyerClient;
  /**
   * Resolve the discoverable resource cards (fixture in tests; live marketplace gated).
   * Resolved ONCE at construction for the per-endpoint tool snapshot; the discovery tool
   * re-reads it at call time.
   */
  cardSource: CardListSource;
  /** The per-tool/-day budget guard (soft cap over the on-chain hard bound). */
  budget: BudgetGuard;
  /**
   * The pre-resolved endpoint-card snapshot. When omitted, createMcpServer resolves
   * cardSource() synchronously-by-microtask (the fixture/test path) and the drive surface
   * awaits it before the first invoke. The bin uses createMcpServerAsync for a clean await.
   */
  cards?: DiscoveredCard[];
  /** The server name/version surfaced to the MCP host. */
  name?: string;
  version?: string;
}

/** The created server + an in-process drive surface for tests (no stdio, no live model). */
export interface CreatedMcpServer {
  /** The underlying McpServer (connect it to a transport in the bin). */
  server: McpServer;
  /** The registered tool names (discovery + per-endpoint). */
  toolNames: string[];
  /** Invoke a registered tool handler in-process by name (tests / programmatic drive). */
  invoke(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Connect the server to a transport (e.g. StdioServerTransport). */
  connect(transport: Parameters<McpServer["connect"]>[0]): Promise<void>;
}

/** Build the per-endpoint tool for a card with the budget guard wired as the pre-pay gate. */
function endpointToolFor(opts: CreateMcpServerOptions, card: DiscoveredCard): BuiltTool {
  // The tool name is needed for the budget key; build once and close over it.
  const tool = buildEndpointTool(
    card,
    // payFn: pay via the client (key in the client closure), then record the debit.
    async (req) => {
      const result = await opts.client.pay(req);
      opts.budget.record(tool.name, result.debitAmount);
      return { response: result.response, debitAmount: result.debitAmount };
    },
    // prePay: the budget guard checks the per-call cap (the card cap = the hard bound).
    () => opts.budget.check(tool.name, card.capBaseUnits),
  );
  return tool;
}

/** Register a built tool on the server + the in-process handler map. */
function registerOne(
  server: McpServer,
  handlers: Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>,
  names: string[],
  tool: {
    name: string;
    config: {
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    };
    handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  },
): void {
  if (handlers.has(tool.name)) return;
  handlers.set(tool.name, tool.handler);
  names.push(tool.name);
  server.registerTool(
    tool.name,
    {
      title: tool.config.title,
      description: tool.config.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: tool.config.inputSchema as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annotations: tool.config.annotations as any,
    },
    // The SDK wrapper calls the SAME in-process handler (the key never reaches here).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (args: any) => {
      const r = await tool.handler((args ?? {}) as Record<string, unknown>);
      return { content: r.content, isError: r.isError };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

/** The internal shared builder over a RESOLVED card snapshot. */
function buildOverSnapshot(
  opts: CreateMcpServerOptions,
  snapshot: DiscoveredCard[],
): CreatedMcpServer {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
  const toolNames: string[] = [];
  const server = new McpServer({
    name: opts.name ?? "utter-buyer",
    version: opts.version ?? "0.0.0",
  });

  const discovery = buildDiscoveryTool(opts.cardSource);
  registerOne(server, handlers, toolNames, {
    name: discovery.name,
    config: discovery.config,
    handler: (args) => discovery.handler(args as { query?: string }),
  });

  for (const card of snapshot) {
    registerOne(server, handlers, toolNames, endpointToolFor(opts, card));
  }

  return {
    server,
    toolNames,
    async invoke(toolName, args) {
      const h = handlers.get(toolName);
      if (!h) {
        return {
          content: [{ type: "text", text: `unknown tool: ${toolName}` }],
          isError: true,
        };
      }
      return h(args);
    },
    async connect(transport) {
      await server.connect(transport);
    },
  };
}

/**
 * Build the MCP server asynchronously, resolving the endpoint-card snapshot from the
 * cardSource (the live/bin path - a clean await). The discovery tool re-reads the source
 * at call time.
 */
export async function createMcpServerAsync(
  opts: CreateMcpServerOptions,
): Promise<CreatedMcpServer> {
  const snapshot = opts.cards ?? (await Promise.resolve(opts.cardSource()));
  return buildOverSnapshot(opts, snapshot);
}

/**
 * Build the MCP server (the test/fixture path). When `cards` is supplied it is used as the
 * snapshot directly; otherwise the drive surface lazily resolves cardSource() on the first
 * invoke/connect and registers the per-endpoint tools then. The discovery tool is always
 * registered eagerly. Tests await invoke(), so the lazy snapshot is registered before any
 * handler runs.
 */
export function createMcpServer(opts: CreateMcpServerOptions): CreatedMcpServer {
  if (opts.cards) {
    return buildOverSnapshot(opts, opts.cards);
  }

  // Lazy snapshot: register the discovery tool now; resolve the endpoint cards on a
  // microtask and register them before the first awaited invoke/connect.
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
  const toolNames: string[] = [];
  const server = new McpServer({
    name: opts.name ?? "utter-buyer",
    version: opts.version ?? "0.0.0",
  });

  const discovery = buildDiscoveryTool(opts.cardSource);
  registerOne(server, handlers, toolNames, {
    name: discovery.name,
    config: discovery.config,
    handler: (args) => discovery.handler(args as { query?: string }),
  });

  const ready = Promise.resolve(opts.cardSource()).then((cards) => {
    for (const card of cards) {
      registerOne(server, handlers, toolNames, endpointToolFor(opts, card));
    }
  });

  return {
    server,
    toolNames,
    async invoke(toolName, args) {
      await ready;
      const h = handlers.get(toolName);
      if (!h) {
        return {
          content: [{ type: "text", text: `unknown tool: ${toolName}` }],
          isError: true,
        };
      }
      return h(args);
    },
    async connect(transport) {
      await ready;
      await server.connect(transport);
    },
  };
}
