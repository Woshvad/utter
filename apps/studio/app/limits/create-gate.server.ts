// create-gate.server.ts - the /create admission gate (S3, module singleton).
//
// Five fixed windows, checked peek-all then commit-all so the FIRST deny wins and a
// denied request inserts NOTHING into any window:
//   1. global_burst    "global"           default 10 / 60s   (CREATE_BURST_GLOBAL)
//   2. global_daily    "global"           default 100 / 24h  (CREATE_LIMIT_GLOBAL_PER_DAY)
//   3. ip_hourly       clientIpKey        default 10 / 1h    (CREATE_LIMIT_PER_IP_PER_HOUR)
//   4. creator_burst   creator lowercase  default 3 / 60s    (CREATE_BURST_PER_CREATOR)
//   5. creator_daily   creator lowercase  default 20 / 24h   (CREATE_LIMIT_PER_CREATOR_PER_DAY)
//
// SIZING (the operator Anthropic spend circuit-breaker, window 2): the worst case
// per create is ~120 model turns, not 8 calls - 2 generation attempts x (24 + 12 +
// 12 + 12) maxTurns across the first pass and the bounded repair loop. A fixed
// window also allows up to 2x the limit across a rollover. That is why the global
// daily default is 100 and why the operator must keep DEFAULT_MODEL on haiku (opus
// multiplies the per-create cost roughly 15x).
//
// WHY THE IP DIMENSION (window 3): wallets are FREE. SIWE signs with any locally
// generated key - no funds, no gas, no bond - so the per-creator windows are
// fairness-only and one attacker can mint unlimited creator identities. The per-IP
// window is what stops a single source from filling the global budget.
//
// Counters are per-process and reset on studio restart/crash (documented; the
// build-slot cap in build-slots.server.ts is what makes a crash-reset non-trivial
// to exploit, since real in-flight builds are bounded independently).
import { FixedWindowLimiter, parsePositiveInt } from "./fixed-window.server.js";

/** The gate verdict: allowed, or denied with the first-failing window's name. */
export type CreateGateVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfterMs: number };

/** One admission window: a limiter plus how to derive its key. */
interface GateWindow {
  reason: string;
  limiter: FixedWindowLimiter;
  keyFor: (creator: string, ipKey: string) => string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The create admission gate. Constructed from env once (the module singleton below);
 * tests construct their own instance with an injected env and clock.
 */
export class CreateGate {
  private readonly windows: GateWindow[];

  constructor(env: NodeJS.ProcessEnv = process.env, now?: () => number) {
    const make = (limit: number, windowMs: number): FixedWindowLimiter =>
      new FixedWindowLimiter({ limit, windowMs, now });
    this.windows = [
      {
        reason: "global_burst",
        limiter: make(parsePositiveInt(env.CREATE_BURST_GLOBAL, 10, "CREATE_BURST_GLOBAL"), MINUTE_MS),
        keyFor: () => "global",
      },
      {
        reason: "global_daily",
        limiter: make(
          parsePositiveInt(env.CREATE_LIMIT_GLOBAL_PER_DAY, 100, "CREATE_LIMIT_GLOBAL_PER_DAY"),
          DAY_MS,
        ),
        keyFor: () => "global",
      },
      {
        reason: "ip_hourly",
        limiter: make(
          parsePositiveInt(env.CREATE_LIMIT_PER_IP_PER_HOUR, 10, "CREATE_LIMIT_PER_IP_PER_HOUR"),
          HOUR_MS,
        ),
        keyFor: (_creator, ipKey) => ipKey,
      },
      {
        reason: "creator_burst",
        limiter: make(
          parsePositiveInt(env.CREATE_BURST_PER_CREATOR, 3, "CREATE_BURST_PER_CREATOR"),
          MINUTE_MS,
        ),
        keyFor: (creator) => creator.toLowerCase(),
      },
      {
        reason: "creator_daily",
        limiter: make(
          parsePositiveInt(
            env.CREATE_LIMIT_PER_CREATOR_PER_DAY,
            20,
            "CREATE_LIMIT_PER_CREATOR_PER_DAY",
          ),
          DAY_MS,
        ),
        keyFor: (creator) => creator.toLowerCase(),
      },
    ];
  }

  /**
   * Check every window (peek), then commit ALL of them only if every window
   * allowed. The first denying window (in the order above) wins; a denied request
   * increments no counter anywhere.
   */
  check(creator: string, ipKey: string): CreateGateVerdict {
    for (const w of this.windows) {
      const verdict = w.limiter.peek(w.keyFor(creator, ipKey));
      if (!verdict.allowed) {
        return { allowed: false, reason: w.reason, retryAfterMs: verdict.retryAfterMs };
      }
    }
    for (const w of this.windows) {
      w.limiter.commit(w.keyFor(creator, ipKey));
    }
    return { allowed: true };
  }
}

/** The module singleton (the buildChannel pattern): constructed lazily from env on
 *  first use so every create action shares the same counters. */
let sharedGate: CreateGate | undefined;

export function createGate(): CreateGate {
  if (!sharedGate) sharedGate = new CreateGate();
  return sharedGate;
}
