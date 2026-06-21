// budget.ts - the per-tool/-day spend-cap guard (BUY-03 / T-07-DENIALOFWALLET).
//
// A SOFT pre-flight guard layered OVER the on-chain signed-cap hard bound. The signed
// `maxAmount` is and stays the hard limit the escrow enforces on-chain; this guard never
// relaxes it - it can only DENY a call the operator's `.env.local` caps disallow. The
// model never controls either cap.
//
// WR-02 (concurrency): the guard is RESERVE-before-pay, not check-then-pay-then-record.
// `reserve` atomically admits the projected spend into BOTH the per-tool and per-day
// PENDING totals and returns a handle (or a typed deny). Concurrent reservations all see
// each other's pending spend, so N parallel calls can never collectively exceed the cap
// (the (N-1)*per-call overshoot of the old TOCTOU path is closed). After the pay settles,
// `commit(handle, actualAmount)` converts the reservation to the ACTUAL debit (reconciling
// the cap-basis reservation down/up to the metered amount); on a pay failure `release`
// undoes the reservation so a reverted pay does not leak budget room. This mirrors the
// facilitator's reserve-before-settle pattern.
//
// `check`/`record` remain as a thin BACKWARD-COMPATIBLE facade over reserve/commit: a
// `check` is a reserve that is immediately released when it would be denied (so a probe
// never leaves a dangling reservation), and `record` is a bare commit of an actual debit.
//
// Shape mirrors the pure quota/strikes reducers: plain in-memory bigint maps keyed by
// tool (and by UTC day for the day dimension), and TYPED allow/deny results (NEVER a throw
// - a thrown error around a debit could carry context that leaks). An unset cap means that
// dimension is unbounded (config-driven from MCP_PER_TOOL_CAP_BASE_UNITS /
// MCP_PER_DAY_CAP_BASE_UNITS).
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

/**
 * A reservation handle returned by a successful {@link BudgetGuard.reserve}. It records the
 * tool, the UTC-day bucket the reservation landed in, and the reserved (cap-basis) amount,
 * so {@link BudgetGuard.commit} / {@link BudgetGuard.release} can reconcile/undo EXACTLY
 * this reservation under concurrency (no cross-call interference). `live` guards against a
 * double commit/release of the same handle.
 */
export interface BudgetReservation {
  ok: true;
  tool: string;
  day: string;
  reserved: bigint;
  live: boolean;
}

/** A reserve outcome: a live handle, or a typed deny (no reservation made). */
export type ReserveResult = BudgetReservation | { ok: false; reason: string };

/** The guard surface: reserve-before-pay + commit/release, plus a check/record facade. */
export interface BudgetGuard {
  /**
   * Atomically RESERVE `amount` (the cap basis) against BOTH dimensions. Returns a live
   * handle on success (the pending totals are advanced immediately so concurrent reserves
   * see it) or a typed deny (no reservation made). The server calls this BEFORE pay.
   */
  reserve(tool: string, amount: bigint): ReserveResult;
  /**
   * Convert a live reservation to the ACTUAL settled debit: release the reserved (cap)
   * amount from pending and add `actualAmount` to the committed totals. Idempotent per
   * handle (a second commit/release is a no-op). Call AFTER a successful pay.
   */
  commit(reservation: BudgetReservation, actualAmount: bigint): void;
  /**
   * Undo a live reservation (release the reserved amount from pending, commit nothing).
   * Idempotent per handle. Call on a pay FAILURE so a reverted pay leaks no budget room.
   */
  release(reservation: BudgetReservation): void;
  /**
   * Backward-compatible facade: a pre-flight check that RESERVES and immediately releases,
   * so a passing check leaves NO dangling reservation (callers must reserve() to hold it).
   * Returns the typed allow/deny.
   */
  check(tool: string, amount: bigint): BudgetDecision;
  /** Backward-compatible facade: commit a bare ACTUAL debit (no prior reservation). */
  record(tool: string, amount: bigint): void;
  /** The current per-tool COMMITTED total (base units) - for diagnostics/tests. */
  spentForTool(tool: string): bigint;
  /** The current per-(UTC-)day COMMITTED total (base units) - for diagnostics/tests. */
  spentForDay(day?: string): bigint;
}

/** The current UTC day key (YYYY-MM-DD) - the per-day bucket boundary. */
function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build a per-tool/-day budget guard. Caps come from `.env.local` config (base-unit
 * bigints); an undefined cap is unbounded. The guard is a SOFT pre-flight - it never
 * relaxes the on-chain signed cap (the hard bound). It is RESERVE-before-pay (WR-02): the
 * reserve/commit/release lifecycle is concurrency-safe (the in-memory maps are mutated
 * synchronously, with no await between read-and-write, so interleaved reserves cannot
 * race in a single-threaded event loop).
 */
export function createBudgetGuard(caps: BudgetCaps): BudgetGuard {
  // COMMITTED totals (settled debits) + PENDING totals (live reservations not yet
  // committed/released). The cap is checked against committed + pending.
  const committedTool = new Map<string, bigint>();
  const committedDay = new Map<string, bigint>();
  const pendingTool = new Map<string, bigint>();
  const pendingDay = new Map<string, bigint>();

  const get = (m: Map<string, bigint>, k: string): bigint => m.get(k) ?? 0n;
  const add = (m: Map<string, bigint>, k: string, delta: bigint): void => {
    const next = get(m, k) + delta;
    if (next <= 0n) m.delete(k);
    else m.set(k, next);
  };

  function spentForTool(tool: string): bigint {
    return get(committedTool, tool);
  }
  function spentForDay(day: string = utcDayKey()): bigint {
    return get(committedDay, day);
  }

  function reserve(tool: string, amount: bigint): ReserveResult {
    if (amount < 0n) {
      return { ok: false, reason: "budget: a negative amount is not allowed" };
    }
    const day = utcDayKey();
    // Check committed + pending + this amount against each cap (no mutation yet).
    if (caps.perToolCapBaseUnits !== undefined) {
      const projected = get(committedTool, tool) + get(pendingTool, tool) + amount;
      if (projected > caps.perToolCapBaseUnits) {
        return {
          ok: false,
          reason: `budget: the per-tool cap for "${tool}" would be exceeded (the on-chain signed cap remains the hard bound)`,
        };
      }
    }
    if (caps.perDayCapBaseUnits !== undefined) {
      const projected = get(committedDay, day) + get(pendingDay, day) + amount;
      if (projected > caps.perDayCapBaseUnits) {
        return {
          ok: false,
          reason:
            "budget: the per-day spend cap would be exceeded (the on-chain signed cap remains the hard bound)",
        };
      }
    }
    // Admit the reservation: advance BOTH pending totals so concurrent reserves see it.
    add(pendingTool, tool, amount);
    add(pendingDay, day, amount);
    return { ok: true, tool, day, reserved: amount, live: true };
  }

  function commit(reservation: BudgetReservation, actualAmount: bigint): void {
    if (!reservation.live) return; // already committed/released - idempotent no-op
    reservation.live = false;
    // Release the reserved (cap) amount from pending.
    add(pendingTool, reservation.tool, -reservation.reserved);
    add(pendingDay, reservation.day, -reservation.reserved);
    // Add the ACTUAL settled debit to committed (a 0/negative debit commits nothing).
    if (actualAmount > 0n) {
      add(committedTool, reservation.tool, actualAmount);
      add(committedDay, reservation.day, actualAmount);
    }
  }

  function release(reservation: BudgetReservation): void {
    if (!reservation.live) return; // already committed/released - idempotent no-op
    reservation.live = false;
    add(pendingTool, reservation.tool, -reservation.reserved);
    add(pendingDay, reservation.day, -reservation.reserved);
  }

  return {
    spentForTool,
    spentForDay,
    reserve,
    commit,
    release,
    // Facade: a check is a reserve that is immediately released when denied (so a probe
    // leaves nothing dangling) AND released when allowed (callers hold via reserve()).
    check(tool, amount): BudgetDecision {
      const r = reserve(tool, amount);
      if (!r.ok) return r;
      release(r);
      return { ok: true };
    },
    // Facade: a bare commit of an ACTUAL debit with no prior reservation (release nothing).
    record(tool, amount): void {
      if (amount <= 0n) return;
      const day = utcDayKey();
      add(committedTool, tool, amount);
      add(committedDay, day, amount);
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
