// probe.ts - the three probe dimensions (SCR-01).
//
// The Scorer probes a deployed resource across three deterministic dimensions and
// composes them into a ProbeResult:
//   1. schema      - reuse @utter/x402-arc buildClassifier(openapi,{successRef,
//                    errorRef}) to classify the response. A `success` OR a
//                    `declared_error` passes (schemaOk=true); only a `malfunction`
//                    fails. A declared_error is valid bad-buyer-input handling, NOT
//                    a creator strike - this is the wrongful-strike guard
//                    (T-05-03-WRONGSTRIKE). The Scorer reuses the SAME classifier
//                    the escrow gate uses so the two agree byte-for-byte.
//   2. latency     - a wall-clock measure vs a configurable budget
//                    (SCORER_LATENCY_BUDGET_MS). Within budget (inclusive) passes.
//   3. correctness - replay each test-cases.json {response, expectedClass} case and
//                    assert the response classifies to its expectedClass.
//
// All three are pure functions over already-captured inputs (the body, the measured
// latency, the replay cases) - no network here. The injectable ResourceProber owns
// the I/O; this module owns the deterministic classification logic.
import { buildClassifier, type ResponseClass } from "@utter/x402-arc";
import type { ProbeResult } from "./prober.js";

/**
 * The resource-named success/error schema refs buildClassifier accepts (its
 * `ClassifierRefs` shape, packages/x402-arc/src/classify.ts:25-30). Re-declared
 * here rather than imported because the x402-arc barrel does not re-export the
 * type; the structural shape is the contract and buildClassifier accepts it.
 */
export interface ClassifierRefs {
  /** The success schema ref; defaults to the echo `EchoSuccess` ref. */
  successRef?: string;
  /** The declared-error schema ref; defaults to the echo `EchoError` ref. */
  errorRef?: string;
}

/** A single test-cases.json replay case (the {response, expectedClass} shape, validate.ts:117). */
export interface TestCase {
  /** An optional human label for the mismatch report. */
  label?: string;
  /** The recorded response body to re-classify. */
  response: unknown;
  /** The class this response must classify to. */
  expectedClass: ResponseClass;
}

/** The schema-dimension outcome: the classification + whether it passed the schema probe. */
export interface SchemaProbe {
  /** The response class buildClassifier assigned. */
  classification: ResponseClass;
  /** True iff the body is success|declared_error (a malfunction is the only failure). */
  schemaOk: boolean;
}

/** The latency-dimension outcome. */
export interface LatencyProbe {
  /** The measured latency in ms. */
  latencyMs: number;
  /** True iff latencyMs <= budgetMs (inclusive). */
  latencyOk: boolean;
}

/** A single correctness mismatch: a case whose response did not classify as expected. */
export interface CorrectnessMismatch {
  /** The case label, if any. */
  label?: string;
  /** The class the case declared it should be. */
  expected: ResponseClass;
  /** The class buildClassifier actually assigned. */
  got: ResponseClass;
}

/** The correctness-dimension outcome over the test-cases replay. */
export interface CorrectnessProbe {
  /** True iff every case classified to its expectedClass. */
  correctnessOk: boolean;
  /** The misclassified cases (empty when correctnessOk). */
  mismatches: CorrectnessMismatch[];
}

/**
 * Schema dimension: classify `body` with the resource's buildClassifier and decide
 * whether it passes the schema probe. A `success` OR a `declared_error` passes
 * (schemaOk=true) - a declared_error is valid bad-buyer-input handling and must
 * NEVER strike the creator (the wrongful-strike guard). Only a `malfunction`
 * (unparseable / matches neither schema) fails. The classifier is the SAME one the
 * escrow gate compiles, so the Scorer and the gate agree byte-for-byte.
 */
export function probeSchema(
  openapi: Record<string, unknown>,
  body: unknown,
  refs?: ClassifierRefs,
): SchemaProbe {
  const classification = buildClassifier(openapi, refs)(body);
  return { classification, schemaOk: classification !== "malfunction" };
}

/**
 * Latency dimension: a wall-clock `latencyMs` passes iff it is within `budgetMs`
 * (inclusive). The budget is configurable (SCORER_LATENCY_BUDGET_MS); the measure
 * itself is captured by the prober, so this stays a pure comparison.
 */
export function probeLatency(latencyMs: number, budgetMs: number): LatencyProbe {
  return { latencyMs, latencyOk: latencyMs <= budgetMs };
}

/**
 * Correctness dimension: replay each test-cases case and assert its `response`
 * classifies to its `expectedClass` via the resource's buildClassifier. Any
 * mismatch fails the dimension and is surfaced so the failure reason is specific.
 * Compiles the classifier ONCE and reuses it across cases.
 */
export function probeCorrectness(
  openapi: Record<string, unknown>,
  cases: readonly TestCase[],
  refs?: ClassifierRefs,
): CorrectnessProbe {
  const classify = buildClassifier(openapi, refs);
  const mismatches: CorrectnessMismatch[] = [];
  for (const tc of cases) {
    const got = classify(tc.response);
    if (got !== tc.expectedClass) {
      mismatches.push({ label: tc.label, expected: tc.expectedClass, got });
    }
  }
  return { correctnessOk: mismatches.length === 0, mismatches };
}

/** The already-captured inputs for one probe of a resource (the prober supplies these). */
export interface ProbeInput {
  /** The resource's parsed openapi doc (the classifier source). */
  openapi: Record<string, unknown>;
  /** The resource-named success/error schema refs (default to the echo refs when absent). */
  refs?: ClassifierRefs;
  /** The captured response body for the schema dimension. */
  body: unknown;
  /** The measured wall-clock latency in ms. */
  latencyMs: number;
  /** The latency budget in ms (SCORER_LATENCY_BUDGET_MS). */
  budgetMs: number;
  /** The test-cases.json replay cases for the correctness dimension. */
  testCases: readonly TestCase[];
}

/**
 * Compose the three dimensions into a single deterministic ProbeResult. `passed` is
 * the AND of the three dimensions; the FIRST failing dimension sets a short,
 * non-secret `reason` (schema -> latency -> correctness order). A `declared_error`
 * body keeps schemaOk true, so a healthy endpoint returning a valid error for bad
 * buyer input PASSES (the wrongful-strike guard end to end).
 */
export function runProbe(input: ProbeInput): ProbeResult {
  const schema = probeSchema(input.openapi, input.body, input.refs);
  const latency = probeLatency(input.latencyMs, input.budgetMs);
  const correctness = probeCorrectness(input.openapi, input.testCases, input.refs);

  const passed = schema.schemaOk && latency.latencyOk && correctness.correctnessOk;
  let reason: string | undefined;
  if (!passed) {
    if (!schema.schemaOk) {
      reason = `schema: response classified as ${schema.classification}`;
    } else if (!latency.latencyOk) {
      reason = `latency: ${latency.latencyMs}ms exceeds budget ${input.budgetMs}ms`;
    } else {
      reason = `correctness: ${correctness.mismatches.length} case(s) misclassified`;
    }
  }

  return {
    passed,
    schemaOk: schema.schemaOk,
    latencyOk: latency.latencyOk,
    correctnessOk: correctness.correctnessOk,
    latencyMs: latency.latencyMs,
    reason,
  };
}
