// Sandbox in-memory run-record store (test default; SBX-04/SBX-06).
//
// Mirrors the Phase 2 pluggable-adapter pattern (services/facilitator/src/
// stores/memory.ts): a `createInMemoryRunStore()` factory returns the SAME
// `RunStore` interface the future Redis-backed adapter (Wave 2+) implements, so
// the autonomous test suite exercises the shared contract with NO isolation host
// and NO Redis. The in-memory adapter is the TEST DEFAULT; the prod adapter is a
// drop-in swap by env at service bootstrap.
//
// A run record is the post-execution accounting of a single sandboxed handler
// invocation: which resource ran, in which backend, the outcome, and the bytes
// in/out (the SBX-04 size cap reads/writes this). It is deliberately backend-
// agnostic so the gvisor (prod) and docker-dev (local, NOT a security boundary)
// runners write the same shape.
import type { Hex } from "viem";
import type { RunBackend } from "../runner/types";

/** How a sandboxed run terminated. */
export type RunOutcome = "success" | "timeout" | "oom" | "killed" | "error";

/** The recorded result of one sandboxed handler invocation. */
export interface RunRecord {
  /** The payment nonce (bytes32 Hex) — the idempotency key shared with the gate. */
  idemKey: Hex;
  /** The resource that ran (bytes32 Hex). */
  resourceId: Hex;
  /** Which isolation backend executed this run. */
  backend: RunBackend;
  /** How the run terminated. */
  outcome: RunOutcome;
  /** Request bytes admitted (post SBX-04 size cap). */
  requestBytes: number;
  /** Response bytes produced (post SBX-04 size cap). */
  responseBytes: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Epoch ms the run record was written. */
  recordedAt: number;
}

/**
 * Persisted sandbox run records, keyed on idemKey. All methods are async so the
 * future Redis-backed adapter implements the identical contract.
 */
export interface RunStore {
  /** Persist a run record. Idempotent on idemKey: a re-put is a no-op. */
  put(record: RunRecord): Promise<void>;
  /** Fetch a run record by idemKey, or null if absent. */
  get(idemKey: Hex): Promise<RunRecord | null>;
}

/**
 * In-memory RunStore (test default). Map-backed; idempotent on idemKey so a
 * retried run never overwrites the first recorded outcome.
 */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<Hex, RunRecord>();

  async put(record: RunRecord): Promise<void> {
    if (!this.runs.has(record.idemKey)) this.runs.set(record.idemKey, record);
  }

  async get(idemKey: Hex): Promise<RunRecord | null> {
    return this.runs.get(idemKey) ?? null;
  }
}

/** The store bundle the sandbox service routes. */
export interface SandboxStores {
  runs: RunStore;
}

/**
 * Build the in-memory sandbox stores (test default — no Redis/isolation host).
 * The future Redis adapter exposes the same `SandboxStores` shape so the runner
 * can swap adapters by env without touching run-record logic.
 */
export function createInMemoryStores(): SandboxStores {
  return {
    runs: new InMemoryRunStore(),
  };
}
