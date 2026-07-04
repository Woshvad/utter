// build-channel.ts - the per-resource in-process build-event pub/sub (1g + S7).
//
// createResource emits the six build stages into this channel keyed by resourceId;
// subscribe drains them as an async iterator the SSE route consumes. The channel is
// a plain promise-resolver queue with NO external npm dependency: each resource
// holds an ordered event buffer, a done flag, and the set of parked reader wakes.
//
// CONTRACT (the load-bearing properties):
//   - subscribe() yields events ALREADY buffered before subscribe() was called, so a
//     late SSE connection still sees Generate (the create action emits before the SSE
//     route ever attaches). The buffer is never drained by emit, only by the reader.
//   - subscribe() RETURNS (the loop ends) once complete() has been called and the
//     buffer is fully drained, so the reader settles rather than hangs.
//   - subscribe() with an aborted (or later-aborting) opts.signal RETURNS: the parked
//     wake races the abort, so a disconnected reader can never park forever (the SSE
//     leak fix - previously an unknown-id subscriber parked at `await new Promise`
//     until process exit).
//   - the capacity check runs SYNCHRONOUSLY inside subscribe() (before the generator
//     is returned), so the SSE route can turn BuildChannelAtCapacityError into a
//     pre-stream 503 instead of erroring mid-stream.
//
// EVICTION (memory bound):
//   (a) a COMPLETE stream with zero subscribers is evicted after a short TTL
//       (default 10 min) by the lazy sweep, keeping late-reload replay working;
//   (b) a NEVER-EMITTED stream (an unknown-id subscribe, the spray vector) is
//       evicted IMMEDIATELY when its last subscriber leaves;
//   (c) the streams map is hard-capped (default 500): creating a stream beyond the
//       cap evicts the oldest zero-subscriber entry, else throws
//       BuildChannelAtCapacityError (the route maps it to 503). emit/complete
//       degrade by dropping (with a warning) rather than throwing, so the create
//       pipeline's background IIFE can never crash on channel pressure.
//
// HONEST SCOPE: this is an in-process, single-runtime channel. It is NOT durable
// and NOT cross-process; the channel is a module singleton (see live-deps.server)
// so the create action and the SSE route reach the SAME instance.
import type { BuildEvent } from "./types.js";

/** Thrown when a new stream cannot be created because the map is at its hard cap
 *  and every existing entry has a live subscriber. The SSE route returns 503. */
export class BuildChannelAtCapacityError extends Error {
  readonly code = "build_channel_at_capacity" as const;
  constructor(max: number) {
    super(`build-event channel is at capacity (${max} streams), retry shortly`);
    this.name = "BuildChannelAtCapacityError";
  }
}

/** The per-resource channel state. */
interface ResourceStream {
  /** Events emitted but not yet consumed by the reader, in emit order. */
  buffer: BuildEvent[];
  /** True once complete() has been called: the reader drains the buffer then returns. */
  done: boolean;
  /** Parked reader wake callbacks (multiple concurrent readers each park one). */
  wakes: Set<() => void>;
  /** Live subscriber count (drives eviction rules a and b). */
  subscribers: number;
  /** True once any event was emitted (a never-emitted stream is spray-evictable). */
  everEmitted: boolean;
  /** Creation order stamp (drives oldest-first cap eviction). */
  createdAt: number;
  /** Set at complete(): the earliest time rule (a) may evict this entry. */
  evictAt?: number;
}

export interface BuildEventChannelOptions {
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
  /** How long a complete, subscriber-free stream stays replayable (default 10 min). */
  completedTtlMs?: number;
  /** Hard cap on the streams map (default 500). */
  maxStreams?: number;
}

const DEFAULT_COMPLETED_TTL_MS = 600_000;
const DEFAULT_MAX_STREAMS = 500;

/**
 * An in-process per-resource build-event channel. A class so live-deps.server can
 * construct one module singleton and tests can construct their own isolated instance.
 */
export class BuildEventChannel {
  /** One stream record per resourceId. Created lazily on first emit/subscribe. */
  private readonly streams = new Map<string, ResourceStream>();
  private readonly now: () => number;
  private readonly completedTtlMs: number;
  private readonly maxStreams: number;

  constructor(opts: BuildEventChannelOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.completedTtlMs = opts.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
    this.maxStreams = opts.maxStreams ?? DEFAULT_MAX_STREAMS;
  }

  /** The number of live stream entries (test/introspection only). */
  get size(): number {
    return this.streams.size;
  }

  /** Eviction rule (a): drop complete, subscriber-free entries past their TTL. Lazy,
   *  invoked on every channel access; O(map size), bounded by the hard cap. */
  private sweep(): void {
    const now = this.now();
    for (const [id, s] of this.streams) {
      if (s.subscribers === 0 && s.done && s.evictAt !== undefined && now >= s.evictAt) {
        this.streams.delete(id);
      }
    }
  }

  /** Get or create the stream record for a resourceId, enforcing the hard cap (rule
   *  c) on creation: evict the oldest zero-subscriber entry, else throw. The lazy
   *  TTL sweep runs on EVERY access so an idle channel entry cannot outlive its TTL
   *  past the next emit/subscribe/complete. */
  private streamFor(resourceId: string): ResourceStream {
    this.sweep();
    let s = this.streams.get(resourceId);
    if (s) return s;
    if (this.streams.size >= this.maxStreams) {
      let victim: string | undefined;
      let victimCreatedAt = Infinity;
      for (const [id, cand] of this.streams) {
        if (cand.subscribers === 0 && cand.createdAt < victimCreatedAt) {
          victim = id;
          victimCreatedAt = cand.createdAt;
        }
      }
      if (victim === undefined) throw new BuildChannelAtCapacityError(this.maxStreams);
      this.streams.delete(victim);
    }
    s = {
      buffer: [],
      done: false,
      wakes: new Set(),
      subscribers: 0,
      everEmitted: false,
      createdAt: this.now(),
    };
    this.streams.set(resourceId, s);
    return s;
  }

  /** Wake every parked reader of a stream exactly once. */
  private wakeAll(s: ResourceStream): void {
    const wakes = [...s.wakes];
    s.wakes.clear();
    for (const wake of wakes) wake();
  }

  /**
   * Append a BuildEvent for a resource and wake any waiting reader. Buffering (not
   * dropping) is what lets a late subscriber still see earlier stages. At hard-cap
   * saturation the event is DROPPED with a warning instead of throwing, so the
   * background create pipeline can never crash on channel pressure.
   */
  emit(resourceId: string, event: BuildEvent): void {
    let s: ResourceStream;
    try {
      s = this.streamFor(resourceId);
    } catch (err) {
      if (err instanceof BuildChannelAtCapacityError) {
        console.warn(`[build-channel] dropping event for ${resourceId}: ${err.message}`);
        return;
      }
      throw err;
    }
    s.everEmitted = true;
    s.buffer.push(event);
    this.wakeAll(s);
  }

  /**
   * Mark a resource's stream done so a draining reader terminates once the buffer is
   * empty. Idempotent. Wakes waiting readers so they observe the done flag and
   * return. Stamps the rule-(a) eviction deadline. Degrades like emit at hard cap.
   */
  complete(resourceId: string): void {
    let s: ResourceStream;
    try {
      s = this.streamFor(resourceId);
    } catch (err) {
      if (err instanceof BuildChannelAtCapacityError) {
        console.warn(`[build-channel] dropping complete for ${resourceId}: ${err.message}`);
        return;
      }
      throw err;
    }
    s.done = true;
    if (s.evictAt === undefined) s.evictAt = this.now() + this.completedTtlMs;
    this.wakeAll(s);
  }

  /**
   * Subscribe to a resource's build events. The stream entry is resolved (and the
   * hard cap enforced) SYNCHRONOUSLY here - a BuildChannelAtCapacityError throws out
   * of this call, before any generator exists, so the SSE route can 503 pre-stream.
   * The returned generator yields every buffered event in order, then awaits the
   * next emit/complete; it RETURNS once the stream is done and the buffer is
   * drained, or as soon as opts.signal aborts (the parked wake races the abort).
   */
  subscribe(
    resourceId: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<BuildEvent> {
    const s = this.streamFor(resourceId);
    return this.iterate(resourceId, s, opts.signal);
  }

  private async *iterate(
    resourceId: string,
    s: ResourceStream,
    signal?: AbortSignal,
  ): AsyncGenerator<BuildEvent> {
    s.subscribers += 1;
    try {
      for (;;) {
        if (signal?.aborted) return;
        if (s.buffer.length > 0) {
          // Shift one event out and yield it. We re-check the buffer each turn so
          // events that arrive while we are suspended at the yield are picked up
          // next loop.
          const next = s.buffer.shift()!;
          yield next;
          continue;
        }
        if (s.done) {
          // Stream completed and the buffer is empty: terminate the reader cleanly.
          return;
        }
        // Buffer empty and not done: park until the next emit/complete OR the abort
        // wakes us. The wake races the abort so a disconnected reader returns.
        await new Promise<void>((resolve) => {
          let settled = false;
          const wake = (): void => {
            if (settled) return;
            settled = true;
            s.wakes.delete(wake);
            signal?.removeEventListener("abort", wake);
            resolve();
          };
          s.wakes.add(wake);
          signal?.addEventListener("abort", wake, { once: true });
        });
      }
    } finally {
      s.subscribers -= 1;
      if (s.subscribers === 0 && !s.everEmitted && !s.done) {
        // Eviction rule (b): a never-emitted stream (unknown-id spray) is dropped
        // the moment its last subscriber leaves. Guard against the entry having
        // been cap-evicted and recreated while we were parked.
        if (this.streams.get(resourceId) === s) this.streams.delete(resourceId);
      }
    }
  }
}
