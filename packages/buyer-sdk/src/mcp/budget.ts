// budget.ts - the per-tool/-day spend-cap guard (BUY-03 / T-07-DENIALOFWALLET).
//
// A SOFT pre-flight guard layered OVER the on-chain signed-cap hard bound. The signed
// `maxAmount` is and stays the hard limit the escrow enforces on-chain; this guard never
// relaxes it - it can only DENY a call the operator's `.env.local` caps disallow. The
// model never controls either cap.
//
// Shape mirrors the pure quota/strikes reducers: plain in-memory bigint maps keyed by
// tool (and by UTC day for the day dimension), a `check` that returns a TYPED allow/deny
// (NEVER a throw - a thrown error around a debit could carry context that leaks), and a
// `record` the server calls only AFTER a settled debit. An unset cap means that dimension
// is unbounded (config-driven from MCP_PER_TOOL_CAP_BASE_UNITS / MCP_PER_DAY_CAP_BASE_UNITS).
//
// All amounts are base-unit bigints (NOT scaled by any decimals literal - the on-chain
// cap is already base units; this guard does pure bigint comparison, no 6/18/1e6 literal).

/** The caps for the guard. An undefined dimension is unbounded. Base-unit bigints. */
export interface BudgetCaps {
  /** The per-tool running cap (base units). Unset = unbounded per tool. */
  perToolCapBaseUnits?: bigint;
  /** The per-UTC-day running cap, summed across ALL tools (base units). Unset = unbounded. */
  perDayCapBaseUnits?: bigint;
}

/** A typed allow/deny result. NEVER thrown - returned so the server can map it to a tool error. */
export type BudgetDecision = { ok: true } | { ok: false; reason: string };

/** The guard surface: a pure pre-flight check + a post-debit record. */
export interface BudgetGuard {
  /** True iff adding `amount` keeps BOTH the per-tool and per-day totals within their caps. */
  check(tool: string, amount: bigint): BudgetDecision;
  /** Advance the per-tool + per-day totals after a SETTLED debit (call only post-pay). */
  record(tool: string, amount: bigint): void;
  /** The current per-tool total (base units) - for diagnostics/tests. */
  spentForTool(tool: string): bigint;
  /** The current per-(UTC-)day total (base units) - for diagnostics/tests. */
  spentForDay(day?: string): bigint;
}

/** The current UTC day key (YYYY-MM-DD) - the per-day bucket boundary. */
function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build a per-tool/-day budget guard. Caps come from `.env.local` config (base-unit
 * bigints); an undefined cap is unbounded. The guard is a SOFT pre-flight - it never
 * relaxes the on-chain signed cap (the hard bound).
 */
export function createBudgetGuard(caps: BudgetCaps): BudgetGuard {
  const perTool = new Map<string, bigint>();
  const perDay = new Map<string, bigint>();

  function spentForTool(tool: string): bigint {
    return perTool.get(tool) ?? 0n;
  }
  function spentForDay(day: string = utcDayKey()): bigint {
    return perDay.get(day) ?? 0n;
  }

  return {
    spentForTool,
    spentForDay,
    check(tool, amount): BudgetDecision {
      if (amount < 0n) {
        return { ok: false, reason: "budget: a negative amount is not allowed" };
      }
      if (caps.perToolCapBaseUnits !== undefined) {
        const next = spentForTool(tool) + amount;
        if (next > caps.perToolCapBaseUnits) {
          return {
            ok: false,
            reason: `budget: the per-tool cap for "${tool}" would be exceeded (the on-chain signed cap remains the hard bound)`,
          };
        }
      }
      if (caps.perDayCapBaseUnits !== undefined) {
        const next = spentForDay() + amount;
        if (next > caps.perDayCapBaseUnits) {
          return {
            ok: false,
            reason: "budget: the per-day spend cap would be exceeded (the on-chain signed cap remains the hard bound)",
          };
        }
      }
      return { ok: true };
    },
    record(tool, amount): void {
      if (amount <= 0n) return;
      perTool.set(tool, spentForTool(tool) + amount);
      const day = utcDayKey();
      perDay.set(day, spentForDay(day) + amount);
    },
  };
}

/**
 * Read the budget caps from env (`.env.local` config). A missing/blank var leaves that
 * dimension UNBOUNDED. Values are base-unit bigints (no decimals scaling here).
 */
export function readBudgetCapsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  const parse = (raw: string | undefined): bigint | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    return BigInt(raw.trim());
  };
  return {
    perToolCapBaseUnits: parse(env.MCP_PER_TOOL_CAP_BASE_UNITS),
    perDayCapBaseUnits: parse(env.MCP_PER_DAY_CAP_BASE_UNITS),
  };
}
