// revenue.ts - the DISPLAY-only revenue read wrapper.
//
// tryGetRevenue calls adapter.getRevenue inside a try/catch and returns null on any
// throw. It is for loaders that read revenue for DISPLAY ONLY, where no money decision
// rides on the value: a transient or unreachable facilitator must degrade the page to a
// dash or an omitted figure, never the crash screen.
//
// It does NOT weaken the fail-loud adapter. Any caller that makes a money decision off
// the revenue must call adapter.getRevenue directly so a failed read still fails loud.
//
// It NEVER fabricates a zero. A failed read is null, which is distinct from a real
// reachable-but-empty zero summary (calls 0, gross 0n). Callers must treat null as
// UNKNOWN (dash / omit), never as a real zero.
//
// This is a pure wrapper with type-only adapter imports, so it is safe in any module
// graph (no .server suffix needed).
import type { StudioDataAdapter, RevenueSummary } from "./types.js";

/**
 * Read a resource's revenue summary for DISPLAY ONLY, tolerating a transient or
 * unreachable facilitator. Returns the summary on success, or null on ANY throw.
 * Null means the read failed (render a dash / omit the figure); it is never a
 * fabricated zero. Do NOT use this where a money decision rides on the value - call
 * adapter.getRevenue directly there so the fail-loud behavior is preserved.
 */
export async function tryGetRevenue(
  adapter: StudioDataAdapter,
  resourceId: string,
): Promise<RevenueSummary | null> {
  try {
    return await adapter.getRevenue(resourceId);
  } catch {
    return null;
  }
}
