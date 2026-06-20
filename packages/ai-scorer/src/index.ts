// @utter/ai-scorer - the off-chain reputation scorer (SCR-01/02/03).
//
// The Scorer is the verification gate before a resource lists and on a schedule. It
// probes a deployed resource across three deterministic dimensions (schema reusing
// @utter/x402-arc buildClassifier, latency vs a budget, correctness by replaying
// test-cases.json), folds each ProbeResult through a PURE 5-CONSECUTIVE-failure
// reducer (a single success resets the counter; 5 in a row deactivate + raise a
// bond-slash-review), and re-scores on a createReconcileLoop-shaped schedule. The
// schema dimension shares the SAME classifier the escrow gate uses, so a
// declared_error (bad buyer input) is NEVER a creator strike - the wrongful-strike
// guard.
//
// Probing runs against an injectable ResourceProber: the FixtureProber is the
// autonomous test default (no network, no API key); the LiveHttpsProber (probing a
// deployed `*.resources.<domain>` endpoint) is operator-gated and inherits the
// Phase 3 wildcard-TLS host prerequisite. The moderation backend lands in a later
// plan; this barrel exposes the scorer surface.

// The injectable prober seam + its backends.
export {
  type ProberBackend,
  type ProbeResult,
  type ProbeTarget,
  type ResourceProber,
  type FixtureSpec,
  FixtureProber,
  LiveHttpsProber,
  RequiresProvisionedHostError,
  selectProber,
} from "./prober.js";

// The three probe dimensions + the composer.
export {
  type TestCase,
  type ClassifierRefs,
  type SchemaProbe,
  type LatencyProbe,
  type CorrectnessProbe,
  type CorrectnessMismatch,
  type ProbeInput,
  probeSchema,
  probeLatency,
  probeCorrectness,
  runProbe,
} from "./probe.js";

// The pure 5-consecutive-failure reducer + the bond-slash-review signal.
export {
  STRIKE_LIMIT,
  type StrikeState,
  type StrikeTransition,
  type StrikeStep,
  type BondSlashReview,
  initialStrikeState,
  reduceStrike,
} from "./strikes.js";

// The scheduled re-scoring loop.
export {
  type ApplyResultEvent,
  type ScoringErrorEvent,
  type ScoringLoopOpts,
  type ScoringLoop,
  createScoringLoop,
} from "./schedule.js";
