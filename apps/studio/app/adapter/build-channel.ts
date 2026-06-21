// build-channel.ts - the per-resource in-process build-event pub/sub (1g).
//
// createResource emits the six build stages into this channel keyed by resourceId;
// subscribeBuildEvents drains them as an async iterator the SSE route consumes. The
// channel is a plain promise-resolver queue with NO external npm dependency (no
// EventEmitter import): each resource holds an ordered event buffer, a done flag, and
// a single pending resolve callback the reader awaits when the buffer is empty and the
// stream is not yet done.
//
// CONTRACT (the load-bearing properties):
//   - subscribe() yields events ALREADY buffered before subscribe() was called, so a
//     late SSE connection still sees Generate (the create action emits before the SSE
//     route ever attaches). The buffer is never drained by emit, only by the reader.
//   - subscribe() RETURNS (the loop ends) once complete() has been called and the
//     buffer is fully drained, so the reader settles rather than hangs.
//   - subscribe() for an unknown resourceId (no events ever emitted, never completed)
//     returns an iterable that simply waits, then settles when complete() is called;
//     it NEVER throws before its first yield (the SSE route 500s on a throw-before-
//     yield, so this path is deliberately non-throwing).
//
// HONEST SCOPE: this is an in-process, single-runtime channel. It is NOT durable and
// NOT cross-process; a created resource's stream lives only in the Node process that
// emitted it. That is acceptable in local-real mode because the create action and the
// SSE route share one Node runtime, and the channel is a module singleton (see
// live-deps.server) so both halves reach the SAME instance.
import type { BuildEvent } from "./types.js";

/** The per-resource channel state: an ordered buffer, a done flag, and at most one
 *  pending reader-wake callback. Multiple concurrent readers are not required (the SSE
 *  route opens one stream per connection); the single-waiter design is sufficient and
 *  keeps the queue allocation-free between events. */
interface ResourceStream {
  /** Events emitted but not yet consumed by the reader, in emit order. */
  buffer: BuildEvent[];
  /** True once complete() has been called: the reader drains the buffer then returns. */
  done: boolean;
  /** The resolve callback a waiting reader registered when the buffer ran empty. */
  wake?: () => void;
}

/**
 * An in-process per-resource build-event channel. A class so live-deps.server can
 * construct one module singleton and tests can construct their own isolated instance.
 */
export class BuildEventChannel {
  /** One stream record per resourceId. Created lazily on first emit/subscribe. */
  private readonly streams = new Map<string, ResourceStream>();

  /** Get the stream record for a resourceId, creating an empty one on first touch. */
  private streamFor(resourceId: string): ResourceStream {
    let s = this.streams.get(resourceId);
    if (!s) {
      s = { buffer: [], done: false };
      this.streams.set(resourceId, s);
    }
    return s;
  }

  /**
   * Append a BuildEvent for a resource and wake any waiting reader. Buffering (not
   * dropping) is what lets a late subscriber still see earlier stages.
   */
  emit(resourceId: string, event: BuildEvent): void {
    const s = this.streamFor(resourceId);
    s.buffer.push(event);
    const wake = s.wake;
    s.wake = undefined;
    if (wake) wake();
  }

  /**
   * Mark a resource's stream done so a draining reader terminates once the buffer is
   * empty. Idempotent. Wakes a waiting reader so it observes the done flag and returns.
   */
  complete(resourceId: string): void {
    const s = this.streamFor(resourceId);
    s.done = true;
    const wake = s.wake;
    s.wake = undefined;
    if (wake) wake();
  }

  /**
   * Subscribe to a resource's build events as an async generator. Yields every
   * buffered event in order, then awaits the next emit/complete; it RETURNS once the
   * stream is done and the buffer is drained. It reaches a yield (or a clean return)
   * without ever throwing first - an unknown resourceId simply waits until complete()
   * and then returns having yielded nothing (the non-throwing path the SSE route needs).
   */
  async *subscribe(resourceId: string): AsyncGenerator<BuildEvent> {
    const s = this.streamFor(resourceId);
    // Drain the buffer, then await the next wake, looping until done-and-empty.
    for (;;) {
      if (s.buffer.length > 0) {
        // Shift one event out and yield it. We re-check the buffer each turn so events
        // that arrive while we are suspended at the yield are picked up next loop.
        const next = s.buffer.shift()!;
        yield next;
        continue;
      }
      if (s.done) {
        // Stream completed and the buffer is empty: terminate the reader cleanly.
        return;
      }
      // Buffer empty and not done: park until the next emit or complete wakes us.
      await new Promise<void>((resolve) => {
        s.wake = resolve;
      });
    }
  }
}
