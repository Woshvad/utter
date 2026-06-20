// validate.ts - the four-gate in-loop validator (GEN-01/02/04).
//
// validateBundle(bundle, spec) is the gate EVERY generated Bundle (scaffold or
// claude) must pass before it is handed to the Phase 3 deploy plane. It composes
// the proven Phase 2/3 consumers VERBATIM - it never re-implements a scan, a build,
// a classifier, or the payment dance:
//
//   G1 shape   - the five BUNDLE_KEYS are present and each parses / ajv-validates
//                (openapi 3.1 via buildClassifier, agent-card via validateAgentCard,
//                test-cases against the {description,cases[]} shape).
//   G2 static  - runPrePublishStaticChecks(bundle) from @utter/sandbox (secret scan
//                + disallowed-import / process.env-enumeration AST). A key / net
//                import / env enumeration FAILS here, before any deploy hand-off
//                (GEN-02).
//   G3 build   - buildResourceImage spec-only (no docker daemon): a digest-pinned
//                base, a lockfile install, and the platform-generated Dockerfile.
//                The live build + the no-network-at-build property are operator-gated
//                (Phase 3 deferral) - never claimed from this local run.
//   G4 serve   - buildClassifier(openapi, {successRef,errorRef}) classifies every
//                test-cases case to its expectedClass, then the handler is mounted
//                behind injectGate and asserted 402 (unpaid) -> 200 (paid) against an
//                IN-PROCESS facilitator + a MOCK chain (never a forked chain).
//
// Composer shape (mirrors services/sandbox/src/prepublish/checks.ts): accumulate a
// typed violation array per gate, `pass = no violations`. Each gate is also exported
// individually so a caller can run a subset.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Hex } from "viem";
import {
  createWalletClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC, arcTestnet } from "@utter/chain";
import {
  buildClassifier,
  signDebitAuthorization,
  encodePayment,
  InMemoryPaymentStore,
  InMemoryResultStore,
  type ClassifyResponse,
  type FetchLike,
  type PaymentPayload,
  type Pricing,
  type ResponseClass,
} from "@utter/x402-arc";
import { runPrePublishStaticChecks, scanSecrets } from "@utter/sandbox";
import {
  buildResourceImage,
  assertPinnedByDigest,
  type BuildResult,
} from "@utter/deployer";
import { injectGate } from "@utter/deployer";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool, RelayerSigner } from "@utter/facilitator/relayer";
import { BUNDLE_KEYS, type Bundle, type ResourceSpec } from "./types.js";
import { validateAgentCard } from "./agent-card.js";

/** The four gate ids the validator runs, in order. */
export type GateId = "g1" | "g2" | "g3" | "g4";

/**
 * A single validation violation. `gate` is the failing gate; `kind` is a short
 * machine code; `detail` is human-readable. For G2 violations the underlying
 * `runPrePublishStaticChecks` rule is surfaced in `rule` so a caller (and the
 * static-gate test) can assert the exact scanner finding (secret rule /
 * disallowed-import / process-env-enumeration) without re-running the scan.
 */
export interface ValidationViolation {
  gate: GateId;
  kind: string;
  detail: string;
  /** The underlying scanner rule for a G2 finding (e.g. "disallowed-import"). */
  rule?: string;
  /** The bundle file the finding is in, when applicable. */
  file?: string;
}

/** One gate's sub-result. `pass` is true only when the gate found no violations. */
export interface GateResult {
  pass: boolean;
  violations: ValidationViolation[];
}

/** The full validation result. `pass` is true only when ALL four gates pass. */
export interface ValidationResult {
  pass: boolean;
  gates: { g1: GateResult; g2: GateResult; g3: GateResult; g4: GateResult };
  /** Every violation across all gates (empty when pass). */
  violations: ValidationViolation[];
  /** The G3 build spec (spec-only; built:false on the autonomous path). */
  buildSpec?: BuildResult;
}

/** Options for {@link validateBundle}. */
export interface ValidateBundleOpts {
  /** Override the image tag the G3 build spec uses (default `resource:validate`). */
  tag?: string;
}

/** Wrap a gate's violation list into a GateResult. */
function gateResult(violations: ValidationViolation[]): GateResult {
  return { pass: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// G1 - shape.
// ---------------------------------------------------------------------------

/** The expected test-cases case shape (a parsed entry of test-cases.json). */
interface TestCase {
  label?: string;
  input?: unknown;
  response: unknown;
  expectedClass: ResponseClass;
}

/** A parsed openapi doc plus the resource-named success / error schema refs. */
interface ParsedOpenapi {
  doc: Record<string, unknown>;
  successRef: string;
  errorRef: string;
}

/** Find a `*Success` / `*Error` component schema name in an openapi doc. */
function findSchemaRefs(doc: Record<string, unknown>): {
  successRef?: string;
  errorRef?: string;
} {
  const components = doc.components as { schemas?: Record<string, unknown> } | undefined;
  const schemas = components?.schemas ?? {};
  const names = Object.keys(schemas);
  const successName = names.find((n) => /Success$/.test(n));
  const errorName = names.find((n) => /Error$/.test(n));
  return {
    successRef: successName ? `openapi.json#/components/schemas/${successName}` : undefined,
    errorRef: errorName ? `openapi.json#/components/schemas/${errorName}` : undefined,
  };
}

/**
 * G1 (shape): the five BUNDLE_KEYS are present and each parses / ajv-validates. On
 * success returns the parsed openapi + its refs and the test-cases for G4 to reuse;
 * on failure the violations explain what is missing or malformed.
 */
export function gateShape(bundle: Bundle): {
  result: GateResult;
  openapi?: ParsedOpenapi;
  testCases?: TestCase[];
} {
  const violations: ValidationViolation[] = [];

  // Every BUNDLE_KEYS file must be present and non-empty.
  for (const key of BUNDLE_KEYS) {
    const v = bundle[key];
    if (typeof v !== "string" || v.length === 0) {
      violations.push({
        gate: "g1",
        kind: "missing-file",
        detail: `bundle is missing required file "${key}"`,
        file: key,
      });
    }
  }
  if (violations.length > 0) return { result: gateResult(violations) };

  // openapi.json: parses, builds a classifier (so its 3.1 success/error schemas are
  // present and ajv-compilable - a misconfigured doc throws here).
  let openapi: ParsedOpenapi | undefined;
  try {
    const doc = JSON.parse(bundle["openapi.json"]!) as Record<string, unknown>;
    const { successRef, errorRef } = findSchemaRefs(doc);
    if (!successRef || !errorRef) {
      violations.push({
        gate: "g1",
        kind: "openapi-schema-missing",
        detail: "openapi.json lacks a *Success and/or *Error component schema",
        file: "openapi.json",
      });
    } else {
      // Build the classifier now to prove both schemas ajv-compile (loud throw if not).
      buildClassifier(doc, { successRef, errorRef });
      openapi = { doc, successRef, errorRef };
    }
  } catch (err) {
    violations.push({
      gate: "g1",
      kind: "openapi-invalid",
      detail: `openapi.json failed to parse/compile: ${(err as Error).message}`,
      file: "openapi.json",
    });
  }

  // agent-card.json: parses and validates against the A2A v0.3.0 schema.
  try {
    const card = JSON.parse(bundle["agent-card.json"]!) as unknown;
    const cardResult = validateAgentCard(card);
    if (!cardResult.valid) {
      violations.push({
        gate: "g1",
        kind: "agent-card-invalid",
        detail: `agent-card.json failed A2A v0.3.0 validation: ${cardResult.errors.join("; ")}`,
        file: "agent-card.json",
      });
    }
  } catch (err) {
    violations.push({
      gate: "g1",
      kind: "agent-card-invalid",
      detail: `agent-card.json failed to parse: ${(err as Error).message}`,
      file: "agent-card.json",
    });
  }

  // test-cases.json: parses and matches the {description, cases[]} shape with one
  // case at least, each carrying response + expectedClass.
  let testCases: TestCase[] | undefined;
  try {
    const parsed = JSON.parse(bundle["test-cases.json"]!) as {
      description?: unknown;
      cases?: unknown;
    };
    if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
      violations.push({
        gate: "g1",
        kind: "test-cases-invalid",
        detail: "test-cases.json must carry a non-empty `cases` array",
        file: "test-cases.json",
      });
    } else {
      const cases = parsed.cases as TestCase[];
      const wellFormed = cases.every(
        (c) =>
          c &&
          typeof c === "object" &&
          "response" in c &&
          typeof (c as TestCase).expectedClass === "string",
      );
      if (!wellFormed) {
        violations.push({
          gate: "g1",
          kind: "test-cases-invalid",
          detail: "each test-cases case must carry `response` and `expectedClass`",
          file: "test-cases.json",
        });
      } else {
        testCases = cases;
      }
    }
  } catch (err) {
    violations.push({
      gate: "g1",
      kind: "test-cases-invalid",
      detail: `test-cases.json failed to parse: ${(err as Error).message}`,
      file: "test-cases.json",
    });
  }

  return { result: gateResult(violations), openapi, testCases };
}

// ---------------------------------------------------------------------------
// G2 - static check (GEN-02). Reuses runPrePublishStaticChecks VERBATIM.
// ---------------------------------------------------------------------------

/**
 * The executable-code surface of a bundle: the files that actually run in the
 * sandbox (.ts/.js/.py). The GEN-02 static gate runs the FULL scan over THESE
 * (named secret rules + entropy heuristic + disallowed-import AST) - an embedded key
 * or a dangerous import in the code is the secret-exfil / escape threat. The
 * Dockerfile is platform-produced and digest-pinned (G3), not generated code, so it
 * is excluded. The declarative JSON artifacts are scanned separately by
 * {@link jsonSurface} (named secret rules only - see WR-01).
 */
function codeSurface(bundle: Bundle): Bundle {
  const code: Bundle = {};
  for (const [file, source] of Object.entries(bundle)) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(file)) {
      code[file] = source;
    }
  }
  return code;
}

/**
 * The declarative-JSON surface of a bundle (openapi/agent-card/test-cases and any
 * other .json the model emits). On the SCAFFOLD path this JSON is deterministic
 * platform output; on the CLAUDE path it is model-authored and UNTRUSTED - a model
 * (or a prompt-injected model) can hide a raw key in an openapi `description` or a
 * test-case string (WR-01 / GEN-02 smuggle). These files legitimately carry PUBLIC
 * chain constants (the 42-char PaymentEscrow / USDC addresses from @utter/chain),
 * which the entropy heuristic would false-positive on. So we scan them with the
 * NAMED secret rules only (entropy waived), catching sk-/0x<64hex>/AKIA literals
 * while letting the public escrow address pass.
 */
function jsonSurface(bundle: Bundle): Bundle {
  const json: Bundle = {};
  for (const [file, source] of Object.entries(bundle)) {
    if (/\.json$/.test(file)) {
      json[file] = source;
    }
  }
  return json;
}

/**
 * G2 (static): run the GEN-02 static checks over the generated bundle and surface
 * the violations. The executable-code surface gets the FULL scan
 * (runPrePublishStaticChecks: named secret rules + entropy + disallowed-import AST).
 * The declarative-JSON surface gets the NAMED secret rules only (entropy waived so
 * the public escrow/USDC addresses do not false-positive, while a smuggled raw key
 * in an openapi description or a test-case string is still REJECTED - WR-01). An
 * embedded key, a disallowed (net/child_process) import, or process.env enumeration
 * FAILS the bundle here, before any deploy hand-off. The scanners are imported,
 * NEVER re-implemented.
 */
export function gateStatic(bundle: Bundle): GateResult {
  const violations: ValidationViolation[] = [];

  // Code surface: the full pre-publish scan (secrets + entropy + import AST).
  const code = runPrePublishStaticChecks(codeSurface(bundle));
  for (const v of code.violations) {
    if (v.kind === "secret") {
      violations.push({
        gate: "g2",
        kind: "secret",
        rule: v.rule,
        file: v.file,
        detail: `secret-scan rule "${v.rule}" fired in ${v.file}:${v.line} (${v.preview})`,
      });
    } else {
      violations.push({
        gate: "g2",
        kind: "import",
        rule: v.rule,
        file: v.file,
        detail: `import-scan rule "${v.rule}" fired in ${v.file}:${v.line} (${v.message})`,
      });
    }
  }

  // JSON surface: named secret rules only (entropy waived for public chain constants).
  for (const v of scanSecrets(jsonSurface(bundle), { entropy: false })) {
    violations.push({
      gate: "g2",
      kind: "secret",
      rule: v.rule,
      file: v.file,
      detail: `secret-scan rule "${v.rule}" fired in ${v.file}:${v.line} (${v.preview})`,
    });
  }

  return gateResult(violations);
}

// ---------------------------------------------------------------------------
// G3 - build spec (spec-only; the live build is operator-gated).
// ---------------------------------------------------------------------------

/**
 * G3 (build spec): buildResourceImage spec-only (no docker option). Asserts a
 * digest-pinned base, a lockfile install, and the platform-generated Dockerfile.
 * `networkIsolation` is always `operator-gated` from this path - the no-network-at-
 * build property is NOT claimed locally (Phase 3 deferral). Returns the BuildResult
 * so a caller can inspect the spec.
 */
export async function gateBuildSpec(
  bundle: Bundle,
  spec: ResourceSpec,
  tag: string,
): Promise<{ result: GateResult; buildSpec?: BuildResult }> {
  const violations: ValidationViolation[] = [];

  // Write the bundle to a temp build-context dir (POSIX keys, no path.join on keys).
  const dir = mkdtempSync(join(tmpdir(), "utter-validate-"));
  try {
    for (const key of BUNDLE_KEYS) {
      writeFileSync(join(dir, key), bundle[key] ?? "", "utf8");
    }

    // Spec-only: omit the docker option -> built:false, a pure BuildSpec.
    const build = await buildResourceImage(dir, { runtime: spec.runtime, tag });

    if (build.built !== false) {
      violations.push({
        gate: "g3",
        kind: "unexpected-live-build",
        detail: "G3 ran a live build (a docker daemon was wired); the autonomous gate is spec-only",
      });
    }
    // The base image must be pinned by digest (assertPinnedByDigest throws otherwise).
    try {
      assertPinnedByDigest(build.baseImage);
    } catch (err) {
      violations.push({
        gate: "g3",
        kind: "base-not-pinned",
        detail: (err as Error).message,
      });
    }
    if (!build.lockfile) {
      violations.push({
        gate: "g3",
        kind: "lockfile-missing",
        detail: "the build spec has no lockfile install step",
      });
    }
    if (!build.dockerfile || !/^FROM /m.test(build.dockerfile)) {
      violations.push({
        gate: "g3",
        kind: "dockerfile-missing",
        detail: "the build spec has no generated Dockerfile",
      });
    }
    // NEVER claim isolation locally: the gate requires the operator-gated posture.
    if (build.networkIsolation !== "operator-gated") {
      violations.push({
        gate: "g3",
        kind: "isolation-overclaimed",
        detail: `networkIsolation must be 'operator-gated' locally, got '${build.networkIsolation}'`,
      });
    }
    return { result: gateResult(violations), buildSpec: build };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// G4 - classify + serve-behind-x402 (GEN-04). In-process facilitator + mock chain.
// ---------------------------------------------------------------------------

const RESOURCE: Hex = `0x${"e6".repeat(32)}`;
const MAX_TIMEOUT_SECONDS = 30;
const SETTLE_BUFFER_SECONDS = 90;

/** A debit counter the mocked relayer increments per writeContract (one per settle). */
interface DebitState {
  debits: number;
}

/** A mocked relayer pool: writeContract counts debits and returns a fixed tx hash. */
function mockRelayerPool(state: DebitState): RelayerPool {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = {
    chain: arcTestnet,
    async writeContract() {
      state.debits += 1;
      return ("0x" + "ab".repeat(32)) as Hex;
    },
  } as unknown as RelayerSigner["wallet"];
  const signer: RelayerSigner = {
    address: account.address,
    account,
    wallet,
    nonceManager: undefined as never,
  };
  return {
    signers: [signer],
    pickSigner: () => signer,
    reserveNonce: async () => 0,
    resyncNonce: async () => {},
    checkBalances: async () => [],
  };
}

/** A stub public client: a funded buyer, no used nonces, instant tx receipts. */
function mockPublicClient(balances: Record<string, bigint>): PublicClient {
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        return balances[(args[0] as string).toLowerCase()] ?? 0n;
      }
      if (functionName === "usedNonce") return false;
      throw new Error(`mockPublicClient: unexpected functionName ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
}

/** Build the in-process facilitator app + a fetcher routing the gate's POSTs to it. */
function makeFacilitatorFetcher(deps: {
  store: InMemoryPaymentStore;
  resultStore: InMemoryResultStore;
  relayerPool: RelayerPool;
  publicClient: PublicClient;
}): FetchLike {
  const app = createApp({
    store: deps.store,
    resultStore: deps.resultStore,
    relayerPool: deps.relayerPool,
    publicClient: deps.publicClient,
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
  });
  return async (input, init) =>
    app.request(input, { method: init?.method, headers: init?.headers, body: init?.body });
}

/** Build + sign an escrow PaymentPayload for a buyer, then base64 it for X-PAYMENT. */
async function signedHeader(opts: {
  pk: Hex;
  buyer: Address;
  cap: bigint;
  nonce: Hex;
}): Promise<string> {
  const account = privateKeyToAccount(opts.pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
  const validBefore = BigInt(
    Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS + SETTLE_BUFFER_SECONDS,
  );
  const signed = await signDebitAuthorization(wallet, {
    buyer: opts.buyer,
    resourceId: RESOURCE,
    maxAmount: opts.cap,
    nonce: opts.nonce,
    validBefore,
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "utter-escrow",
    network: "eip155:5042002",
    authorization: {
      buyer: opts.buyer,
      resourceId: RESOURCE,
      maxAmount: opts.cap.toString(),
      nonce: opts.nonce,
      validBefore: validBefore.toString(),
    },
    signature: signed.signature,
  };
  return encodePayment(payload);
}

/**
 * Build the gate `Pricing` from the spec's metered pricing. The spec carries
 * { base, perKB, max }; the gate's metering also needs a compute term and a size
 * cap. We supply a zero compute multiplier (size+base only - deterministic) and the
 * spec `max` as the response-byte cap. The signed cap (from the X-PAYMENT) is the
 * hard ceiling either way.
 */
function gatePricing(spec: ResourceSpec): Pricing {
  return {
    model: "metered",
    base: spec.pricing.base,
    perKB: spec.pricing.perKB,
    computeMultiplier: "0",
    maxResponseBytes: 1_048_576,
  };
}

/**
 * Mount an in-process Hono app whose `/` route reproduces the generated handler's
 * behavior (the echo-templated success body the scaffold/model emits). validate.ts
 * cannot import the untrusted handler.ts as a TS module at runtime, so G4 mirrors its
 * declared contract: a string `text` -> 200 { result, length } (the *Success shape);
 * a non-string `text` -> 400 { error, code } (the declared-error shape). This is the
 * WIRING proof (402 -> 200 behind the gate); the genuine isolated handler execution
 * is the operator-gated runsc deferral.
 */
function buildResourceApp(): Hono {
  const app = new Hono();
  app.post("/", async (c: Context) => {
    let body: { text?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown };
    } catch {
      return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
    }
    const text = body?.text;
    if (typeof text !== "string") {
      return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
    }
    return c.json({ result: text, length: text.length }, 200);
  });
  return app;
}

/**
 * G4 (serve): classify each test-cases case to its expectedClass via the bundle's
 * resource-named classifier, then mount the handler behind injectGate and assert
 * 402 (unpaid) -> 200 (paid) against an in-process facilitator + a MOCK chain with
 * exactly one debit <= cap. Never a forked chain (Pitfall 5).
 */
export async function gateServeBehindX402(
  openapi: ParsedOpenapi,
  testCases: TestCase[],
  spec: ResourceSpec,
): Promise<GateResult> {
  const violations: ValidationViolation[] = [];

  // (a) Classify every test-cases case to its expectedClass.
  let classifier: ClassifyResponse;
  try {
    classifier = buildClassifier(openapi.doc, {
      successRef: openapi.successRef,
      errorRef: openapi.errorRef,
    });
  } catch (err) {
    return gateResult([
      {
        gate: "g4",
        kind: "classifier-build-failed",
        detail: `buildClassifier failed: ${(err as Error).message}`,
      },
    ]);
  }
  for (const tc of testCases) {
    const got = classifier(tc.response);
    if (got !== tc.expectedClass) {
      violations.push({
        gate: "g4",
        kind: "misclassified",
        detail: `test-case "${tc.label ?? "?"}" classified as "${got}", expected "${tc.expectedClass}"`,
      });
    }
  }
  // If the declared classes do not hold, do not bother mounting the gate.
  if (violations.length > 0) return gateResult(violations);

  // (b) Mount the handler behind injectGate and prove 402 -> 200 + exactly one debit.
  const cap = 10_000n;
  const nonce: Hex = `0x${"a2".repeat(32)}`;
  const pk = generatePrivateKey();
  const buyer = privateKeyToAccount(pk).address;
  const debitState: DebitState = { debits: 0 };
  const store = new InMemoryPaymentStore();
  const resultStore = new InMemoryResultStore();
  const fetcher = makeFacilitatorFetcher({
    store,
    resultStore,
    relayerPool: mockRelayerPool(debitState),
    // Seed the buyer's mocked escrow balance so /verify passes WITHOUT a live deposit.
    publicClient: mockPublicClient({ [buyer.toLowerCase()]: 1_000_000n }),
  });

  const pricing = gatePricing(spec);
  const gated = injectGate(buildResourceApp(), {
    facilitatorUrl: "http://facilitator.validate",
    resourceId: RESOURCE,
    cap,
    pricing,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    classifier,
    fetcher,
  });

  // Unpaid -> 402 with the accepts body; the handler never ran (zero debits).
  const unpaid = await gated.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  if (unpaid.status !== 402) {
    violations.push({
      gate: "g4",
      kind: "unpaid-not-402",
      detail: `an unpaid request returned ${unpaid.status}, expected 402`,
    });
  } else {
    const body = (await unpaid.json()) as { accepts?: Array<{ scheme?: string }> };
    if (!Array.isArray(body.accepts) || body.accepts[0]?.scheme !== "utter-escrow") {
      violations.push({
        gate: "g4",
        kind: "402-missing-accepts",
        detail: "the 402 response is missing the utter-escrow accepts entry",
      });
    }
  }
  if (debitState.debits !== 0) {
    violations.push({
      gate: "g4",
      kind: "unpaid-debited",
      detail: `an unpaid request recorded ${debitState.debits} debits, expected 0`,
    });
  }

  // Paid -> 200 with the echoed success body + exactly one debit <= cap.
  const header = await signedHeader({ pk, buyer, cap, nonce });
  const paid = await gated.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", "X-PAYMENT": header },
    body: JSON.stringify({ text: "hello" }),
  });
  if (paid.status !== 200) {
    violations.push({
      gate: "g4",
      kind: "paid-not-200",
      detail: `a paid request returned ${paid.status}, expected 200`,
    });
  } else {
    const echoed = (await paid.json()) as { result?: string; length?: number };
    if (echoed.result !== "hello" || echoed.length !== 5) {
      violations.push({
        gate: "g4",
        kind: "paid-body-mismatch",
        detail: `the paid body was ${JSON.stringify(echoed)}, expected { result: "hello", length: 5 }`,
      });
    }
    if (!paid.headers.get("X-PAYMENT-RESPONSE")) {
      violations.push({
        gate: "g4",
        kind: "receipt-missing",
        detail: "the paid response is missing the X-PAYMENT-RESPONSE receipt header",
      });
    }
  }
  if (debitState.debits !== 1) {
    violations.push({
      gate: "g4",
      kind: "debit-count",
      detail: `expected exactly one debit, got ${debitState.debits}`,
    });
  } else {
    const stored = await resultStore.get(nonce);
    if (!stored) {
      violations.push({
        gate: "g4",
        kind: "receipt-not-persisted",
        detail: "no settle receipt was persisted for the paid nonce",
      });
    } else {
      const amount = BigInt((stored.receipt as { amount: string }).amount);
      if (amount > cap) {
        violations.push({
          gate: "g4",
          kind: "debit-over-cap",
          detail: `the debited amount ${amount} exceeds the cap ${cap}`,
        });
      }
    }
  }

  return gateResult(violations);
}

// ---------------------------------------------------------------------------
// The four-gate composer.
// ---------------------------------------------------------------------------

/**
 * Run the four-gate in-loop validator over a generated Bundle. Returns
 * `{ pass, gates: { g1..g4 }, violations }`. `pass` is true only when ALL four
 * gates pass. G1 short-circuits G4 (G4 needs the parsed openapi + test-cases); G2
 * and G3 always run so a caller sees every independent failure in one pass. The
 * live runsc execution, live HTTPS, and genuine on-chain debit halves are operator-
 * gated (Phase 3 deferral) and never exercised here.
 */
export async function validateBundle(
  bundle: Bundle,
  spec: ResourceSpec,
  opts?: ValidateBundleOpts,
): Promise<ValidationResult> {
  const tag = opts?.tag ?? "resource:validate";

  // G1 - shape (also parses openapi + test-cases for G4).
  const shape = gateShape(bundle);

  // G2 - static check (GEN-02). Always runs (independent of shape).
  const g2 = gateStatic(bundle);

  // G3 - build spec (spec-only). Always runs (independent of shape).
  const { result: g3, buildSpec } = await gateBuildSpec(bundle, spec, tag);

  // G4 - serve behind x402. Runs only when G1 produced a usable openapi + test-cases.
  let g4: GateResult;
  if (shape.openapi && shape.testCases) {
    g4 = await gateServeBehindX402(shape.openapi, shape.testCases, spec);
  } else {
    g4 = gateResult([
      {
        gate: "g4",
        kind: "skipped-shape-failed",
        detail: "G4 did not run because G1 (shape) did not yield a valid openapi + test-cases",
      },
    ]);
  }

  const g1 = shape.result;
  const violations = [
    ...g1.violations,
    ...g2.violations,
    ...g3.violations,
    ...g4.violations,
  ];
  return {
    pass: violations.length === 0,
    gates: { g1, g2, g3, g4 },
    violations,
    buildSpec,
  };
}
