// prober.ts - the injectable ResourceProber seam (SCR-01).
//
// ResourceProber mirrors the cross-phase pluggable-adapter-with-deterministic-
// test-default pattern (Phase 2 PaymentStore, Phase 3 SandboxRunner at
// services/sandbox/src/runner/types.ts:136-147, Phase 4 Generator). The interface
// carries a `readonly backend` discriminator; selectProber(env) returns the
// deterministic FixtureProber by default and the operator-gated LiveHttpsProber
// only when a wildcard-TLS resources host is configured. The whole autonomous
// suite probes via the FixtureProber and never touches a network path.
//
// The live HTTPS prober (probing a deployed `*.resources.<domain>` endpoint)
// inherits the Phase 3 wildcard-TLS host prerequisite (a Deferred Item); it
// throws RequiresProvisionedHostError so the autonomous suite cannot mistake the
// stub for a live probe (mirrors createOperatorGatedProbe in
// services/sandbox/src/prepublish/probe.ts).

/** Which prober backend produced a result - the deterministic-default discriminator. */
export type ProberBackend = "fixture" | "live-https";

/**
 * The deterministic outcome of probing a resource across the three dimensions.
 * `passed` is the strike input: false counts toward a strike, true resets the
 * consecutive counter. A `declared_error` body keeps `schemaOk` true (it is valid
 * bad-buyer-input handling, NOT a creator strike - the wrongful-strike guard).
 */
export interface ProbeResult {
  /** True iff schema + latency + correctness all held - the strike-reducer input. */
  passed: boolean;
  /** The schema dimension: the body classified as success|declared_error (not malfunction). */
  schemaOk: boolean;
  /** The latency dimension: the wall-clock measure was within the budget. */
  latencyOk: boolean;
  /** The correctness dimension: every test-cases case classified to its expectedClass. */
  correctnessOk: boolean;
  /** The measured probe latency in ms. */
  latencyMs: number;
  /** A short, non-secret reason a probe failed (absent when passed). */
  reason?: string;
}

/** What a prober is asked to probe - a resource identified by its on-chain id. */
export interface ProbeTarget {
  /** The resourceId (a 0x-hex string) the prober is probing. */
  resourceId: string;
  /** Optional probe URL for the LIVE prober (operator-gated; ignored by the fixture). */
  url?: string;
}

/**
 * The pluggable resource prober. Two backends implement it: `fixture` (the
 * deterministic autonomous default, no network) and `live-https` (the operator-
 * gated HTTPS prober against a deployed `*.resources.<domain>` endpoint). The
 * interface is identical so the suite exercises the same contract with no host
 * (mirrors SandboxRunner).
 */
export interface ResourceProber {
  /** Which backend this prober is. */
  readonly backend: ProberBackend;
  /** Probe a resource, returning its deterministic ProbeResult. */
  probe(target: ProbeTarget): Promise<ProbeResult>;
}

/** A fixed ProbeResult, or a per-resourceId map of them. */
export type FixtureSpec = ProbeResult | Record<string, ProbeResult>;

/**
 * The autonomous test-default prober. It returns a CONFIGURED ProbeResult with no
 * network: either one fixed result for every resource, or a per-resourceId map.
 * A synthetic probe stream (a sequence of FixtureProbers, or one returning varied
 * results) drives the strike reducer and the schedule loop deterministically.
 */
export class FixtureProber implements ResourceProber {
  readonly backend = "fixture" as const;
  private readonly spec: FixtureSpec;

  constructor(spec: FixtureSpec) {
    this.spec = spec;
  }

  async probe(target: ProbeTarget): Promise<ProbeResult> {
    if (isProbeResult(this.spec)) return this.spec;
    const hit = this.spec[target.resourceId];
    if (!hit) {
      throw new Error(`FixtureProber: no fixture result for resourceId ${target.resourceId}`);
    }
    return hit;
  }
}

/** True iff `spec` is a single ProbeResult rather than a per-resource map. */
function isProbeResult(spec: FixtureSpec): spec is ProbeResult {
  return typeof (spec as ProbeResult).passed === "boolean";
}

/**
 * The error thrown when the live HTTPS prober is invoked without the operator-
 * provisioned wildcard-TLS resources host. The live scheduled probe over
 * `*.resources.<domain>` inherits the Phase 3 host prerequisite (Deferred Item);
 * it is NOT autonomous (mirrors RequiresProvisionedHostError in the sandbox probe).
 */
export class RequiresProvisionedHostError extends Error {
  readonly code = "requiresProvisionedHost" as const;
  constructor() {
    super(
      "LiveHttpsProber requires the operator-provisioned wildcard-TLS resources host " +
        "(*.resources.<domain>). Live HTTPS probing is operator-gated; it is NOT autonomous.",
    );
    this.name = "RequiresProvisionedHostError";
  }
}

/**
 * The operator-gated live HTTPS prober stub. It is NEVER available autonomously:
 * `probe` throws RequiresProvisionedHostError so the autonomous suite cannot
 * mistake it for a live probe. The real implementation fetches the deployed
 * `*.resources.<domain>` endpoint, measures latency, and classifies the response
 * with the same buildClassifier the fixture path replays; it is wired against the
 * provisioned host in a later operator-gated plan.
 */
export class LiveHttpsProber implements ResourceProber {
  readonly backend = "live-https" as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async probe(_target: ProbeTarget): Promise<ProbeResult> {
    throw new RequiresProvisionedHostError();
  }
}

/**
 * Env-driven backend selection (mirrors selectGenerator in
 * packages/ai-runtime/src/generator.ts:37-45). Defaults to the FixtureProber
 * whenever SCORER_PROBER is `fixture` OR no live HTTPS host is configured - so the
 * autonomous suite never reaches a network path. Selects the operator-gated
 * LiveHttpsProber only when SCORER_LIVE_HTTPS_HOST is present and the prober is
 * not explicitly forced to fixture. The FixtureProber needs a fixture spec, so the
 * default fixture uses a benign always-pass result when none is supplied; callers
 * that drive a synthetic stream construct FixtureProber directly.
 */
export function selectProber(
  env: NodeJS.ProcessEnv = process.env,
  fixture: FixtureSpec = ALWAYS_PASS,
): ResourceProber {
  if (env.SCORER_PROBER === "fixture" || !env.SCORER_LIVE_HTTPS_HOST) {
    return new FixtureProber(fixture);
  }
  return new LiveHttpsProber();
}

/** A benign always-pass fixture result (the selectProber default with no live host). */
const ALWAYS_PASS: ProbeResult = {
  passed: true,
  schemaOk: true,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 0,
};
