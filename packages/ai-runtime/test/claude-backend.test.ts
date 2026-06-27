// claude-backend.test.ts - the OPERATOR-GATED claude backend is type-checkable,
// selectable, and constructed without any network call. This suite NEVER invokes
// ClaudeGenerator.generate (that path needs ANTHROPIC_API_KEY + network and is
// validated by the same four 04-03 gates, never run autonomously). The only runtime
// assertions are: the discriminator, network-free construction, and that the public
// generate() barrel routes through selectGenerator to the scaffold backend with no
// key. The agent-loop constraints are asserted statically by reading the source.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  ClaudeGenerator,
  buildRepairPrompt,
  buildValidationRepairPrompt,
  findMissingModelFiles,
  isModelRepairable,
} from "../src/claude-backend.js";
import { generate } from "../src/index.js";
import type { ValidationViolation } from "../src/validate.js";
import { BUNDLE_KEYS } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

describe("ClaudeGenerator (operator-gated - constructed, never invoked)", () => {
  it("has the claude discriminator", () => {
    const gen = new ClaudeGenerator({ apiKey: "sk-ant-test", model: "claude-sonnet-4-6" });
    expect(gen.backend).toBe("claude");
  });

  it("constructs without any network call (config stored only)", () => {
    // A throw or hang here would mean construction contacted the network. The
    // constructor must only store config - the model is reached solely in generate().
    expect(
      () => new ClaudeGenerator({ apiKey: "sk-ant-test", model: "claude-opus-4-8" }),
    ).not.toThrow();
  });
});

describe("claude-backend.ts source discipline (static assertions, no runtime call)", () => {
  const src = readFileSync(join(SRC, "claude-backend.ts"), "utf8");

  it("imports the Agent SDK query() loop", () => {
    expect(src).toContain('from "@anthropic-ai/claude-agent-sdk"');
    expect(src).toContain("query(");
  });

  it("carries the loud operator-gated header", () => {
    expect(src).toContain("OPERATOR-GATED");
    expect(src.toLowerCase()).toContain("never the ci");
  });

  it("constrains the toolset: Write/Read only, Bash/WebFetch/WebSearch disallowed, settingSources []", () => {
    expect(src).toContain('allowedTools: ["Write", "Read"]');
    expect(src).toContain('disallowedTools: ["Bash", "WebFetch", "WebSearch"]');
    expect(src).toContain("settingSources: []");
  });

  it("overwrites the Dockerfile via the platform generateDockerfile (never model free-form)", () => {
    expect(src).toContain("generateDockerfile");
    expect(src).toContain('bundle["Dockerfile"]');
  });

  it("passes the configured apiKey + model through to the query() call (WR-02)", () => {
    // The executor must honor the selector's key/model, not silently depend on the
    // ambient process env. The model flows via options.model and the key via the
    // SDK env override (which replaces the subprocess env).
    expect(src).toContain("model: this.config.model");
    expect(src).toContain("ANTHROPIC_API_KEY: this.config.apiKey");
  });

  it("bounds the untrusted model temp tree read (WR-03)", () => {
    // readBundleFromDir must cap file count + size and reject non-BUNDLE_KEYS files.
    expect(src).toContain("MAX_BUNDLE_FILES");
    expect(src).toContain("MAX_BUNDLE_FILE_BYTES");
    expect(src).toContain("BUNDLE_KEY_SET.has");
  });

  it("cleans up the temp dir in a finally (IN-05)", () => {
    expect(src).toContain("finally");
    expect(src).toContain("rmSync(tmpDir");
  });

  it("drives both passes through a shared runAgent closure (refactor cannot regress)", () => {
    // A substring check on the shared closure + maxTurns parameter, not an exact
    // turn count - the closure refactor must stay so both passes share one sandbox.
    expect(src).toContain("runAgent(");
    expect(src).toContain("maxTurns");
  });

  it("runs the four-gate validateBundle inside generate, bounded, before returning", () => {
    // The validation-driven repair loop self-corrects a model-fixable gate failure.
    // It runs the SAME validateBundle the caller uses (gate is never weakened) and is
    // bounded by MAX_VALIDATION_REPAIRS so it can never loop unbounded.
    expect(src).toContain("validateBundle(bundle, spec)");
    expect(src).toContain("MAX_VALIDATION_REPAIRS");
    expect(src).toContain("isModelRepairable");
    expect(src).toContain("buildValidationRepairPrompt");
    // The repair loop must reassemble through assembleBundle so the platform Dockerfile
    // + agent-card overwrites run on every pass.
    expect(src).toContain("assembleBundle(tmpDir, spec)");
  });

  it("logs only gate/kind ids in the validation loop, never the violation detail", () => {
    // A g2 secret violation's detail carries a preview fragment; the log must use
    // `${v.gate}/${v.kind}` only - never v.detail, the prompt, output, or the api key.
    expect(src).toContain("`${v.gate}/${v.kind}`");
    expect(src).not.toContain("fixable.map((v) => v.detail");
  });

  it("wraps generation in a bounded fresh-regeneration loop with a fresh temp dir per attempt", () => {
    // The model is stochastic; a clean restart (fresh tmpDir + fresh agent context) is the
    // durable recovery for an intermittent skipped file. The loop is bounded by
    // MAX_GENERATION_ATTEMPTS, and the temp dir is created INSIDE the loop (per attempt).
    expect(src).toContain("MAX_GENERATION_ATTEMPTS");
    expect(src).toContain("genAttempt <= MAX_GENERATION_ATTEMPTS");
    // mkdtempSync must be inside the attempt loop, not once before it.
    const loopIdx = src.indexOf("genAttempt = 1");
    const mkIdx = src.indexOf("mkdtempSync(join(tmpdir()");
    expect(loopIdx).toBeGreaterThan(0);
    expect(mkIdx).toBeGreaterThan(loopIdx);
  });

  it("wraps the agent loop in try/catch and re-throws bearer-free context only", () => {
    // A transient SDK/API throw must not leak the prompt/output/key, and must surface a
    // safe reason so the attempt can retry fresh or propagate to the build stream.
    expect(src).toContain("claude agent loop failed");
  });
});

describe("generate() barrel (autonomous: scaffold-only, no key)", () => {
  it("routes through selectGenerator to the scaffold backend with no ANTHROPIC_API_KEY", async () => {
    const bundle = await generate(
      {
        prompt: "Echo the input text back with its length.",
        runtime: "node",
        pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
      },
      {}, // empty env -> scaffold backend, zero model calls
    );
    expect(Object.keys(bundle).sort()).toEqual([...BUNDLE_KEYS].sort());
  });
});

describe("buildRepairPrompt (pure, no model call)", () => {
  it("names the single missing file and the required handler export", () => {
    const prompt = buildRepairPrompt(["handler.ts"]);
    expect(prompt).toContain("handler.ts");
    // The repair prompt restates the handler export signature when handler.ts is
    // missing, so the model re-emits the mandatory core with the right shape.
    expect(prompt).toContain("Promise<Response>");
    // It also re-asserts the handler-first ordering (mirrors system-prompt.md) since the
    // observed failure is the model skipping the mandatory core.
    expect(prompt).toContain("handler.ts FIRST");
  });

  it("names all missing files when several are missing", () => {
    const prompt = buildRepairPrompt(["handler.ts", "openapi.json"]);
    expect(prompt).toContain("handler.ts");
    expect(prompt).toContain("openapi.json");
  });
});

describe("findMissingModelFiles (pure, temp dir, no model call)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns all three required model files for an empty dir", () => {
    dir = mkdtempSync(join(tmpdir(), "utter-gen-test-"));
    expect(findMissingModelFiles(dir)).toEqual([
      "handler.ts",
      "openapi.json",
      "test-cases.json",
    ]);
  });

  it("returns only handler.ts when the other two exist", () => {
    dir = mkdtempSync(join(tmpdir(), "utter-gen-test-"));
    writeFileSync(join(dir, "openapi.json"), "{}");
    writeFileSync(join(dir, "test-cases.json"), "{}");
    expect(findMissingModelFiles(dir)).toEqual(["handler.ts"]);
  });

  it("returns empty when all three exist", () => {
    dir = mkdtempSync(join(tmpdir(), "utter-gen-test-"));
    writeFileSync(join(dir, "handler.ts"), "export {}");
    writeFileSync(join(dir, "openapi.json"), "{}");
    writeFileSync(join(dir, "test-cases.json"), "{}");
    expect(findMissingModelFiles(dir)).toEqual([]);
  });
});

describe("isModelRepairable (pure, no model call)", () => {
  const v = (gate: ValidationViolation["gate"], kind: string): ValidationViolation => ({
    gate,
    kind,
    detail: `${gate}/${kind}`,
  });

  it("is true for model-authored g1/g2/g4 failures the model can fix", () => {
    expect(isModelRepairable(v("g1", "test-cases-invalid"))).toBe(true);
    expect(isModelRepairable(v("g1", "openapi-invalid"))).toBe(true);
    expect(isModelRepairable(v("g1", "missing-file"))).toBe(true);
    expect(isModelRepairable(v("g2", "secret"))).toBe(true);
    expect(isModelRepairable(v("g2", "import"))).toBe(true);
    expect(isModelRepairable(v("g4", "misclassified"))).toBe(true);
    expect(isModelRepairable(v("g4", "classifier-build-failed"))).toBe(true);
  });

  it("is false for the platform-owned g3 build spec (the model cannot fix it)", () => {
    expect(isModelRepairable(v("g3", "base-not-pinned"))).toBe(false);
    expect(isModelRepairable(v("g3", "lockfile-missing"))).toBe(false);
    expect(isModelRepairable(v("g3", "dockerfile-missing"))).toBe(false);
  });

  it("is false for the g4 skipped-shape-failed meta-violation (its cause is a g1 failure)", () => {
    expect(isModelRepairable(v("g4", "skipped-shape-failed"))).toBe(false);
  });

  it("is false for agent-card-invalid (the platform overwrites the card on assembly)", () => {
    expect(isModelRepairable(v("g1", "agent-card-invalid"))).toBe(false);
  });
});

describe("buildValidationRepairPrompt (pure, no model call)", () => {
  it("lists each violation's file + detail so the model fixes the exact failure", () => {
    const prompt = buildValidationRepairPrompt([
      {
        gate: "g1",
        kind: "test-cases-invalid",
        detail: "each test-cases case must carry `response` and `expectedClass`",
        file: "test-cases.json",
      },
    ]);
    expect(prompt).toContain("test-cases.json");
    expect(prompt).toContain("each test-cases case must carry `response` and `expectedClass`");
    expect(prompt).toContain("FAILED the platform validator");
    expect(prompt).toContain("Keep the exact five-file contract");
  });

  it("appends the handler signature hint when a violation touches handler.ts", () => {
    const prompt = buildValidationRepairPrompt([
      {
        gate: "g1",
        kind: "missing-file",
        detail: 'bundle is missing required file "handler.ts"',
        file: "handler.ts",
      },
    ]);
    expect(prompt).toContain("Promise<Response>");
    expect(prompt).toContain("handler.ts FIRST");
  });

  it("omits the handler hint when no violation touches handler.ts", () => {
    const prompt = buildValidationRepairPrompt([
      {
        gate: "g1",
        kind: "openapi-invalid",
        detail: "openapi.json failed to parse/compile",
        file: "openapi.json",
      },
    ]);
    expect(prompt).not.toContain("Promise<Response>");
  });

  it("never embeds an api key, the model output, or the original prompt", () => {
    // The repair prompt is built ONLY from gate findings - it must not carry secrets.
    const prompt = buildValidationRepairPrompt([
      { gate: "g2", kind: "secret", detail: 'secret-scan rule "x" fired', file: "handler.ts" },
    ]);
    expect(prompt).not.toContain("sk-ant");
    expect(prompt).not.toContain("ANTHROPIC_API_KEY");
  });
});
