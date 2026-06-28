// Graceful shutdown helper (Provisioning track, subtask 3).
//
// A dependency-free, cross-service shutdown sequencer. It owns the STRICT teardown
// ORDER every long-lived service needs on a SIGTERM/SIGINT (a `docker stop`): stop
// accepting new connections, DRAIN the in-flight requests to completion, stop any
// background loop, then close the pools/clients - and only then exit. The load-bearing
// invariant is that nothing the in-flight requests depend on (the pg pool, the redis
// client) is closed until the drain has finished, so an in-flight /settle (the money
// path) always runs to completion before its store is torn down.
//
// DEPENDENCY-FREE BY DESIGN: this module imports no pg / ioredis / hono. It operates on
// an injected HttpServerLike (the @hono/node-server serve() handle is a node http.Server
// that satisfies it) plus plain callbacks, so it stays reusable across the facilitator,
// deployer, and marketplace without dragging any of their store dependencies into this
// package.
//
// SECRETS: the logger only ever emits non-secret strings here (a signal name, a phase
// label, a timeout notice, an Error.message). It NEVER echoes a DATABASE_URL / REDIS_URL
// / auth secret; callers pass closeables that already keep their own URLs private.
//
// EXIT semantics: a clean shutdown (or a drain bounded by the timeout) exits 0; only an
// UNEXPECTED throw in the sequencer body exits 1. onExit is injectable so a test drives
// the whole sequence and asserts the exit code WITHOUT terminating the test runner.

/**
 * The minimal http.Server surface the sequencer needs. The @hono/node-server serve()
 * return value (a node http.Server) satisfies this structurally:
 *   - close(cb) stops accepting NEW connections and invokes cb once every in-flight
 *     request has finished (the drain signal).
 *   - closeIdleConnections() drops idle keep-alive sockets so they do not hold the drain
 *     open for their full keep-alive timeout.
 *   - closeAllConnections() force-closes EVERY socket, including in-flight ones; used
 *     only as the bounded-timeout escape hatch.
 * The two close-*Connections methods are optional so an older/alternate server still
 * type-checks; absent ones are simply skipped.
 */
export interface HttpServerLike {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

/** A non-secret logger sink. Defaults to console.log; only non-secret strings reach it. */
export type ShutdownLogger = (message: string) => void;

/** Options for {@link runGracefulShutdown}. */
export interface GracefulShutdownOptions {
  /** The serve() handle whose intake is stopped and whose connections are drained. */
  server: HttpServerLike;
  /**
   * The max time in ms to wait for in-flight requests to drain before force-closing the
   * remaining sockets (closeAllConnections) and continuing. Default 10000.
   */
  drainTimeoutMs?: number;
  /**
   * Run AFTER the drain and BEFORE the closeables. The deployer passes its reconcile
   * loop.stop() here: after the drain so a running tick is not cut mid-flight, before the
   * closeables so no later tick fires a store call against a client that is being closed.
   */
  beforeClosePools?: () => void | Promise<void>;
  /**
   * The pool/client closers (pg.end / redis.quit / disconnect). Each runs via
   * Promise.allSettled so one failing closeable never skips the others; each closeable
   * is expected to keep its own URL/secret private (this sequencer logs only the
   * non-secret Error.message on a rejection).
   */
  closeables?: Array<() => Promise<void>>;
  /** Non-secret log sink. Default console.log. */
  logger?: ShutdownLogger;
  /**
   * The process exit. Default process.exit. Injectable so tests assert the exit code
   * without terminating the runner.
   */
  onExit?: (code: number) => void;
  /** The signals register() listens on. Default ['SIGTERM', 'SIGINT']. */
  signals?: NodeJS.Signals[];
}

/** The handle {@link runGracefulShutdown} returns. */
export interface GracefulShutdown {
  /**
   * Run the teardown sequence once. A second call (e.g. a second signal) returns the
   * SAME in-flight promise and does nothing else (double-signal idempotency).
   */
  shutdown: (signal?: string) => Promise<void>;
  /** Register the shutdown on each configured signal via process.once. */
  register: () => void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/**
 * Build a graceful-shutdown sequencer over an injected server + callbacks.
 *
 * The returned shutdown() runs this STRICT ORDER, which is the load-bearing invariant:
 *   1. IDEMPOTENCY: a closure `started` flag; a second call returns the in-flight promise.
 *   2. STOP INTAKE: server.close(cb) (no new connections; cb fires when in-flight done)
 *      plus an immediate server.closeIdleConnections() so idle keep-alives do not hold
 *      the drain.
 *   3. DRAIN with a bounded timeout: race the close-cb against drainTimeoutMs; on timeout
 *      log a non-secret notice and call server.closeAllConnections() to force stragglers,
 *      then continue.
 *   4. STOP LOOP: await beforeClosePools() (after the drain so a running tick is not cut;
 *      before the closeables so no tick hits a closing client).
 *   5. CLOSE CLOSEABLES: every closeable via Promise.allSettled (independent; a rejection
 *      is logged non-secret, never thrown, never echoing a URL).
 *   6. EXIT: onExit(0). The whole body is wrapped so an UNEXPECTED throw logs + onExit(1).
 */
export function runGracefulShutdown(opts: GracefulShutdownOptions): GracefulShutdown {
  const {
    server,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    beforeClosePools,
    closeables = [],
    logger = console.log,
    onExit = (code: number) => process.exit(code),
    signals = DEFAULT_SIGNALS,
  } = opts;

  // Double-signal idempotency: the first call captures the in-flight promise; every later
  // call returns that same promise and runs no part of the sequence a second time.
  let inFlight: Promise<void> | null = null;

  async function runOnce(signal?: string): Promise<void> {
    const label = signal ? ` (${signal})` : "";
    logger(`graceful shutdown starting${label}`);

    // 2. STOP INTAKE. server.close stops accepting new connections and resolves the
    // callback once every in-flight request has finished. closeIdleConnections drops
    // idle keep-alive sockets immediately so they cannot hold the drain open.
    const drained = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeIdleConnections?.();

    // 3. DRAIN with a bounded timeout. Race the drain against the timer; on timeout,
    // force-close any straggler sockets and continue (a hung request must never block
    // the whole shutdown forever). The timer is cleared on a clean drain so it never
    // keeps the event loop alive.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), drainTimeoutMs);
      // Do not let the drain timer hold the process open on its own.
      (timer as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([drained.then(() => "drained" as const), timedOut]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      logger(
        `drain did not complete within ${drainTimeoutMs}ms; force-closing remaining connections`,
      );
      server.closeAllConnections?.();
    }

    // 4. STOP LOOP. After the drain so a running tick is not cut; before the closeables
    // so no later tick fires a store call against a client that is being closed.
    if (beforeClosePools) await beforeClosePools();

    // 5. CLOSE CLOSEABLES. Each is independent: Promise.allSettled so one rejection never
    // skips the others. A rejection is logged with the Error.message ONLY (callers keep
    // their own URLs/secrets private), never re-thrown.
    const results = await Promise.allSettled(closeables.map((close) => close()));
    for (const result of results) {
      if (result.status === "rejected") {
        const reason = result.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        logger(`a shutdown closeable failed (continuing): ${message}`);
      }
    }

    logger("graceful shutdown complete");
  }

  async function shutdown(signal?: string): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await runOnce(signal);
        // 6. EXIT clean.
        onExit(0);
      } catch (err) {
        // An UNEXPECTED throw in the sequencer body. Log the non-secret message and exit
        // non-zero so an operator/orchestrator sees the failed teardown.
        const message = err instanceof Error ? err.message : String(err);
        logger(`graceful shutdown failed: ${message}`);
        onExit(1);
      }
    })();
    return inFlight;
  }

  function register(): void {
    for (const signal of signals) {
      // process.once so a single signal runs the handler once; the in-flight guard in
      // shutdown() additionally collapses a SIGTERM-then-SIGINT into one sequence.
      process.once(signal, () => {
        void shutdown(signal);
      });
    }
  }

  return { shutdown, register };
}
