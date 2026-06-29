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
// inherits the Phase 3 wildcard-TLS host prerequisite (a Deferred Item) and is
// operator-gated by selectProber (it constructs the live prober only when
// SCORER_LIVE_HTTPS_HOST is set), so the autonomous suite never reaches it.
//
// The live prober runs a NO-PAY liveness + conformance probe: it has no wallet,
// never signs, never broadcasts, never reads a key, and handles no money amount or
// chainId. It fetches the resource's agent card over HTTPS (200, https-only),
// validates it with an injectable card-validator seam (a dependency-free light
// structural default), then makes one UNPAID POST to the resource's `/call`
// endpoint that must return 402 (proving the x402 pay gate is enforced - a 200 is
// a free-serve money leak, a 5xx is a broken endpoint), and checks the round-trip
// latency against a budget. A probe FAILURE (network error, non-200 card, invalid
// card, non-402 gate, over-budget latency) returns a `{ passed:false, ..., reason }`
// ProbeResult - it never throws for a bad endpoint, so the publish gate cleanly
// rejects and the strike reducer counts it.

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

/** A minimal fetch seam (default globalThis.fetch); tests inject a fake. */
export type ProbeFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** A card validator seam (default = a dependency-free light structural check). */
export type ProbeCardValidator = (card: unknown) => { valid: boolean; errors: string[] };

/** Construction options for the live prober (all defaulted; tests inject fakes). */
export interface LiveHttpsProberOptions {
  fetcher?: ProbeFetch;
  validateCard?: ProbeCardValidator;
  /** Latency budget in ms for the /call round-trip. Default: env SCORER_LATENCY_BUDGET_MS or 10000. */
  budgetMs?: number;
  /** Injectable clock for testing latency (default Date.now). */
  now?: () => number;
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
 * Retained for back-compat. The live HTTPS prober no longer throws this in probe()
 * - it now performs a real no-pay liveness + conformance probe and returns a failed
 * ProbeResult for a bad endpoint instead of throwing. The error type stays exported
 * because earlier callers referenced it; selectProber still gates LiveHttpsProber
 * construction on the operator-provisioned wildcard-TLS host (SCORER_LIVE_HTTPS_HOST),
 * so the live prober is never reached autonomously.
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

/** The A2A card path suffix a deployed resource serves (EXACTLY this; never agent.json). */
const CARD_PATH = "/.well-known/agent-card.json";
/** The default /call round-trip latency budget in ms. */
const DEFAULT_PROBE_BUDGET_MS = 10_000;

/**
 * Strip the card path to the resource base, then append the `/call` pay path the
 * inject-x402 gate wraps (mirrors deriveEndpointUrl in
 * apps/studio/app/adapter/playground-live.server.ts).
 */
function deriveCallUrl(cardUrl: string): string {
  const base = cardUrl.endsWith(CARD_PATH) ? cardUrl.slice(0, -CARD_PATH.length) : cardUrl;
  return `${base.replace(/\/+$/, "")}/call`;
}

/** Ensure the URL ends with the card path (the publish gate may pass the resource base). */
function normalizeCardUrl(url: string): string {
  return url.endsWith(CARD_PATH) ? url : `${url.replace(/\/+$/, "")}${CARD_PATH}`;
}

/**
 * A LIGHT, dependency-free liveness check that the served body is a plausible Utter
 * A2A v0.3.0 card. It is faithful to the shape in @utter/ai-runtime agent-card.ts but
 * intentionally light: the AUTHORITATIVE ajv validation runs at publish-mint, and the
 * buyer re-pins + validates the served card before paying. This prober does NOT pay, so
 * a structural liveness check is the right bar, and it is kept dependency-free so the lean
 * scorer pulls in nothing heavy. A caller that has the real validateAgentCard MAY inject
 * it via the `validateCard` option.
 */
function lightValidateCard(card: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof card !== "object" || card === null || Array.isArray(card)) {
    return { valid: false, errors: ["card is not a non-null object"] };
  }
  const c = card as Record<string, unknown>;
  if (c.protocolVersion !== "0.3.0") errors.push("protocolVersion is not 0.3.0");
  if (!Array.isArray(c.skills) || c.skills.length < 1) errors.push("skills is not a non-empty array");
  const x402 = c.x402;
  if (typeof x402 !== "object" || x402 === null || Array.isArray(x402)) {
    errors.push("x402 is not an object");
  } else {
    const x = x402 as Record<string, unknown>;
    if (x.scheme !== "utter-escrow") errors.push("x402.scheme is not utter-escrow");
    if (typeof x.asset !== "string") errors.push("x402.asset is not a string");
    if (x.escrow === undefined || x.escrow === null) errors.push("x402.escrow is absent");
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

/** Resolve the latency budget: explicit override, then env, then the default (all positive-finite). */
function resolveBudgetMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  const env = Number(process.env.SCORER_LATENCY_BUDGET_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_PROBE_BUDGET_MS;
}

/** Build a failed ProbeResult (the live prober never throws for a bad endpoint). */
function failed(parts: {
  schemaOk: boolean;
  latencyOk: boolean;
  correctnessOk: boolean;
  latencyMs: number;
  reason: string;
}): ProbeResult {
  return { passed: false, ...parts };
}

/**
 * The operator-gated live HTTPS prober. It performs a real NO-PAY liveness +
 * conformance probe: HTTPS card fetch (200) + light validate -> schemaOk; one UNPAID
 * POST to the derived `/call` URL that must return 402 -> correctnessOk; the round-trip
 * latency vs the budget -> latencyOk. It has no wallet and never pays, signs, or reads a
 * key. selectProber constructs it ONLY when SCORER_LIVE_HTTPS_HOST is set, so the
 * autonomous suite never reaches it. A probe failure returns passed:false (it never
 * throws for a bad endpoint), feeding the publish gate (PublishUnverified) and the strike
 * reducer.
 *
 * What it does NOT do: it does not run the paid correctness classifier (that needs a
 * funded buyer), and it does not re-run the authoritative ajv card schema (that runs at
 * publish-mint); the light validator is a structural liveness check.
 */
export class LiveHttpsProber implements ResourceProber {
  readonly backend = "live-https" as const;
  private readonly fetcher: ProbeFetch;
  private readonly validateCard: ProbeCardValidator;
  private readonly budgetMs: number;
  private readonly now: () => number;

  constructor(opts: LiveHttpsProberOptions = {}) {
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init as RequestInit));
    this.validateCard = opts.validateCard ?? lightValidateCard;
    this.budgetMs = resolveBudgetMs(opts.budgetMs);
    this.now = opts.now ?? Date.now;
  }

  async probe(target: ProbeTarget): Promise<ProbeResult> {
    const raw = target.url;
    if (typeof raw !== "string" || raw.length === 0) {
      return failed({
        schemaOk: false,
        latencyOk: false,
        correctnessOk: false,
        latencyMs: 0,
        reason: "live probe: no target url",
      });
    }
    // Minimal SSRF guard; host-allowlisting is the operator's network boundary.
    if (!raw.startsWith("https://")) {
      return failed({
        schemaOk: false,
        latencyOk: false,
        correctnessOk: false,
        latencyMs: 0,
        reason: "live probe: non-https url rejected",
      });
    }

    // (1) Fetch the served agent card over HTTPS.
    const cardUrl = normalizeCardUrl(raw);
    let cardRes: { status: number; json: () => Promise<unknown> };
    try {
      cardRes = await this.fetcher(cardUrl, { method: "GET" });
    } catch (e) {
      return failed({
        schemaOk: false,
        latencyOk: false,
        correctnessOk: false,
        latencyMs: 0,
        reason: `live probe: card fetch failed: ${errMsg(e)}`,
      });
    }
    if (cardRes.status !== 200) {
      return failed({
        schemaOk: false,
        latencyOk: false,
        correctnessOk: false,
        latencyMs: 0,
        reason: `live probe: card not served (status ${cardRes.status})`,
      });
    }

    // (2) Parse + light-validate the card -> schemaOk.
    let card: unknown;
    try {
      card = await cardRes.json();
    } catch (e) {
      return failed({
        schemaOk: false,
        latencyOk: false,
        correctnessOk: false,
        latencyMs: 0,
        reason: `live probe: card not json: ${errMsg(e)}`,
      });
    }
    const v = this.validateCard(card);
    if (!v.valid) {
      return failed({
        schemaOk: false,
        latencyOk: false,
        correctnessOk: false,
        latencyMs: 0,
        reason: `live probe: invalid card: ${v.errors.join("; ")}`,
      });
    }
    // schemaOk is now true.

    // (3) One UNPAID POST to /call must return 402; measure the round-trip latency.
    const callUrl = deriveCallUrl(cardUrl);
    const start = this.now();
    let status: number;
    try {
      const r = await this.fetcher(callUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "utter-probe" }),
      });
      status = r.status;
    } catch (e) {
      const latencyMs = this.now() - start;
      return failed({
        schemaOk: true,
        latencyOk: latencyMs <= this.budgetMs,
        correctnessOk: false,
        latencyMs,
        reason: `live probe: /call unreachable: ${errMsg(e)}`,
      });
    }
    const latencyMs = this.now() - start;

    // (4) 402 = the pay gate correctly challenges the unpaid call; 200 = free-serve
    // money leak; anything else = broken. Latency vs the budget.
    const correctnessOk = status === 402;
    const latencyOk = latencyMs <= this.budgetMs;
    const passed = correctnessOk && latencyOk; // schemaOk already true here.
    if (passed) {
      return { passed: true, schemaOk: true, latencyOk: true, correctnessOk: true, latencyMs };
    }
    const reason = !correctnessOk
      ? `live probe: pay gate not enforced (status ${status}, expected 402)`
      : `live probe: latency ${latencyMs}ms exceeds budget ${this.budgetMs}ms`;
    return { passed: false, schemaOk: true, latencyOk, correctnessOk, latencyMs, reason };
  }
}

/** Extract a short, non-secret message from an unknown thrown value. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
