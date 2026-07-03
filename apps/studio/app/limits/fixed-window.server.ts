// fixed-window.server.ts - the shared in-process fixed-window rate limiter (S1).
//
// Peek/commit split: callers peek EVERY applicable window first and commit ALL of
// them only when every window allowed. A denied request must insert NOTHING, so a
// spray of denied requests cannot grow any counter (and cannot starve an honest
// caller who retries after the window).
//
// HONEST SCOPE: counters live in this Node process only. They reset on studio
// restart/crash and are not shared across replicas. That is acceptable because the
// build-slot cap (build-slots.server.ts) is the true in-flight bound; these windows
// are the admission throttle in front of it.

/**
 * Parse a positive-integer env knob. The ONLY env number parser the limits modules
 * use: trim, Number, require Number.isFinite && > 0, else the default. NEVER
 * `Number(env.X ?? D)` - "" coerces to 0 (bricks the limiter) and "5O" coerces to
 * NaN (fails open). An unset/empty variable falls back silently (the normal case);
 * a set-but-invalid value falls back with a one-line warning so a typo is visible.
 */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  console.warn(`[limits] ${name}="${raw}" is not a positive number; using default ${fallback}`);
  return fallback;
}

/** The non-mutating peek result for one key in one window. */
export interface PeekResult {
  /** True when a commit for this key would stay within the window limit. */
  allowed: boolean;
  /** Milliseconds until the current window rolls over (0 when allowed). */
  retryAfterMs: number;
  /** How many commits remain in the current window for this key. */
  remaining: number;
}

/** One key's counter inside the current fixed window. */
interface WindowEntry {
  windowStart: number;
  count: number;
}

export interface FixedWindowOptions {
  /** Max commits per key per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
  /** Hard cap on tracked keys; the oldest window is evicted when full. */
  maxKeys?: number;
}

/** The default hard cap on the number of tracked keys per limiter. */
const DEFAULT_MAX_KEYS = 10_000;

/**
 * A fixed-window counter keyed by string. Memory is REALLY bounded: expired entries
 * are lazily swept on access (throttled to once per window), and a hard map-size cap
 * evicts the entry with the oldest windowStart when an insert would exceed it.
 *
 * Fixed-window boundary caveat (documented for sizing): a caller can spend up to a
 * full limit at the end of one window and again at the start of the next, so the
 * worst case across a rollover is 2x the configured limit.
 */
export class FixedWindowLimiter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private lastSweepAt: number;

  constructor(opts: FixedWindowOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    this.lastSweepAt = this.now();
  }

  /** The number of tracked keys (test/introspection only). */
  get size(): number {
    return this.entries.size;
  }

  /** True when the entry's window has fully elapsed at `now`. */
  private expired(entry: WindowEntry, now: number): boolean {
    return now - entry.windowStart >= this.windowMs;
  }

  /** Drop every expired entry. Throttled to once per window length per instance so
   *  a hot key does not pay an O(n) scan on every access. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [key, entry] of this.entries) {
      if (this.expired(entry, now)) this.entries.delete(key);
    }
  }

  /**
   * Non-mutating check: would one commit for this key stay within the limit? Never
   * increments a counter, so a caller can peek several windows and only commit when
   * all of them allow (a denied request inserts nothing anywhere).
   */
  peek(key: string): PeekResult {
    const now = this.now();
    this.maybeSweep(now);
    const entry = this.entries.get(key);
    if (!entry || this.expired(entry, now)) {
      return { allowed: true, retryAfterMs: 0, remaining: this.limit };
    }
    if (entry.count < this.limit) {
      return { allowed: true, retryAfterMs: 0, remaining: this.limit - entry.count };
    }
    return {
      allowed: false,
      retryAfterMs: Math.max(1, entry.windowStart + this.windowMs - now),
      remaining: 0,
    };
  }

  /**
   * Record one hit for the key in the current window. Callers must only commit
   * after every applicable window peeked allowed. Inserting a new key at the hard
   * cap first sweeps expired entries, then evicts the oldest windowStart.
   */
  commit(key: string): void {
    const now = this.now();
    this.maybeSweep(now);
    const entry = this.entries.get(key);
    if (entry && !this.expired(entry, now)) {
      entry.count += 1;
      return;
    }
    if (!this.entries.has(key) && this.entries.size >= this.maxKeys) {
      this.evictForInsert(now);
    }
    this.entries.set(key, { windowStart: now, count: 1 });
  }

  /** Make room for one insert: sweep expired unconditionally, then evict the entry
   *  with the oldest windowStart if the map is still full. The map can therefore
   *  never exceed maxKeys. */
  private evictForInsert(now: number): void {
    for (const [key, entry] of this.entries) {
      if (this.expired(entry, now)) this.entries.delete(key);
    }
    if (this.entries.size < this.maxKeys) return;
    let oldestKey: string | undefined;
    let oldestStart = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.windowStart < oldestStart) {
        oldestStart = entry.windowStart;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
