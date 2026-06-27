// claude-backend.ts - the LIVE, OPERATOR-GATED model generation backend.
//
// !!! READ THIS BEFORE USING THIS FILE !!!
// This path is OPERATOR-GATED. It needs ANTHROPIC_API_KEY plus network access and
// is NEVER the CI / autonomous default. selectGenerator returns the scaffold
// backend whenever ANTHROPIC_API_KEY is absent, so the autonomous test suite never
// reaches this module at runtime. Constructing ClaudeGenerator performs NO network
// call - the model is contacted only inside generate().
//
// The model output is UNTRUSTED and is NEVER relied upon for correctness. It is
// validated by the SAME four 04-03 gates as the scaffold (shape, static-check,
// build, classify+serve-behind-x402). The scaffold backend is the guaranteed-valid
// floor; this backend is enrichment that produces the SAME five-file bundle shape.
//
// Tool/setting restrictions are load-bearing (T-04-02-TOOL): the agent loop may
// only Write/Read files, never run Bash or fetch the web, never inherit local
// Claude settings (settingSources: []), and writes ONLY into an absolute temp cwd.
// The Dockerfile the model emits is DISCARDED and overwritten by the platform
// generateDockerfile (digest-pinned, SBX-05) - the model only declares runtime +
// deps, never the FROM line.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { generateDockerfile, PINNED_BASE_IMAGES } from "@utter/deployer";
import { DEFAULT_MAX_RESPONSE_BYTES } from "@utter/sandbox";
import type { Generator } from "./generator.js";
import { buildAgentCard } from "./agent-card.js";
import { validateBundle, type ValidationViolation } from "./validate.js";
import { BUNDLE_KEYS, type Bundle, type ResourceSpec } from "./types.js";

/**
 * Read caps for the UNTRUSTED model temp tree (WR-03). The model is explicitly
 * untrusted: a model that emits hundreds of files, a multi-GB file, or a deep tree
 * would otherwise be read unbounded into memory before any gate runs. We bound the
 * file count and reuse the sandbox's per-file size cap (DEFAULT_MAX_RESPONSE_BYTES,
 * 1 MB) so an over-large or extra-file output is REJECTED, not blindly ingested.
 * BUNDLE_KEYS is the exact-five contract; the Dockerfile is overwritten anyway.
 */
const MAX_BUNDLE_FILES = BUNDLE_KEYS.length;
const MAX_BUNDLE_FILE_BYTES = DEFAULT_MAX_RESPONSE_BYTES;

/** Config for the operator-gated claude backend. */
export interface ClaudeGeneratorConfig {
  apiKey: string;
  model: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(MODULE_DIR, "..", "skills");

/** Read a skill asset by name (absolute path, ESM-safe - RESEARCH Pitfall 1). */
function readSkill(name: string): string {
  return readFileSync(join(SKILLS_DIR, name), "utf8");
}

/** Build the per-spec generation prompt from the bundle contract + the spec. */
function buildPrompt(spec: ResourceSpec): string {
  const contract = readSkill("bundle-contract.md");
  const upstreams =
    spec.upstreams && spec.upstreams.length > 0
      ? `Allowlisted upstream hosts (reach ONLY via the data-proxy): ${spec.upstreams.join(", ")}`
      : "This resource has no upstreams; it is self-contained.";
  return [
    `Generate the five-file Utter resource bundle for this request:`,
    ``,
    spec.prompt,
    ``,
    `Runtime: ${spec.runtime}.`,
    upstreams,
    ``,
    `Follow this bundle contract exactly:`,
    ``,
    contract,
  ].join("\n");
}

/** The exact-five contract keys, as a Set for membership checks. */
const BUNDLE_KEY_SET = new Set<string>(BUNDLE_KEYS);

/**
 * The REQUIRED MODEL-AUTHORED files a repair pass must check and regenerate. These
 * are the three files the model truly authors AND that survive into the final
 * bundle. The other two BUNDLE_KEYS members are platform-overwritten AFTER
 * generation: Dockerfile by generateDockerfile and agent-card.json by
 * buildAgentCard. A repair pass for those would be wasted work since the model's
 * versions are discarded, so the missing-file check covers ONLY these three.
 */
const REQUIRED_MODEL_FILES: readonly string[] = [
  "handler.ts",
  "openapi.json",
  "test-cases.json",
];

/**
 * Pure helper: given a directory, return the subset of REQUIRED_MODEL_FILES that do
 * NOT exist on disk. No reads, no model call - just existence checks over the
 * provided dir, so it is unit-testable in isolation with no network.
 */
export function findMissingModelFiles(dir: string): string[] {
  return REQUIRED_MODEL_FILES.filter((f) => !existsSync(join(dir, f)));
}

/**
 * Pure helper: build the one-shot repair prompt naming the files the first pass left
 * out. Dependency-free (reads no skill file) so it is unit-testable. When handler.ts
 * is missing it restates the required handler export signature, since handler.ts is
 * the mandatory core the first pass tends to skip (observed live as g1/missing-file).
 */
export function buildRepairPrompt(missing: string[]): string {
  const lines = [
    "Your previous output was INCOMPLETE: it did not write every required file.",
    "",
    "Missing files:",
    ...missing.map((f) => `- ${f}`),
    "",
    "Write each missing file now per the five-file bundle contract you were given.",
  ];
  if (missing.includes("handler.ts")) {
    lines.push(
      "",
      "handler.ts must export `async function handler(c: Context): Promise<Response>`.",
    );
  }
  lines.push(
    "",
    "Do NOT modify the files that already exist. Emit ONLY the missing files, then stop.",
  );
  return lines.join("\n");
}

/**
 * The hard cap on validation-driven repair passes (PART of the bounded-loop
 * guarantee). The first pass plus the one missing-file repair already ran; this bounds
 * the EXTRA model passes the four-gate validator may trigger. At most two, so the whole
 * generation is at most: first pass + 1 missing-file repair + 2 validation repairs. An
 * un-repaired bundle then falls through to the caller's validateBundle (the final
 * authority), which rejects it fail-closed. NEVER an unbounded loop.
 */
const MAX_VALIDATION_REPAIRS = 2;

/**
 * Pure predicate: is this validation violation something the MODEL authored and can
 * fix by rewriting its files? True only for the model-authored gates (g1 shape, g2
 * static, g4 serve), EXCLUDING:
 *  - any g3 violation: g3 is the platform build spec (digest-pinned Dockerfile +
 *    lockfile) which the model never authors, so re-prompting cannot fix it.
 *  - "skipped-shape-failed": a g4 meta-violation that only means g1 failed; the real
 *    g1 violation is already in the list and will be repaired, so this is noise.
 *  - "agent-card-invalid": agent-card.json is platform-overwritten on every assembly
 *    (buildAgentCard), so it cannot actually fail post-assembly; excluding it is
 *    defensive and avoids a wasted repair of a file the model does not own.
 * Anything else on g1/g2/g4 (a malformed test-cases.json, an uncompilable openapi, a
 * smuggled secret, a misclassified case) is genuinely the model's to fix.
 */
export function isModelRepairable(v: ValidationViolation): boolean {
  if (v.gate === "g3") return false;
  if (v.kind === "skipped-shape-failed") return false;
  if (v.kind === "agent-card-invalid") return false;
  return v.gate === "g1" || v.gate === "g2" || v.gate === "g4";
}

/**
 * Pure helper: build the validation repair prompt from the gate violations. Lists each
 * problem as `- [file] detail` using the validator's own human-readable `detail` so the
 * model fixes the exact failure (e.g. "each test-cases case must carry `response` and
 * `expectedClass`"). Restates the handler export signature when any violation touches
 * handler.ts. Dependency-free (reads no skill file) so it is unit-testable. It NEVER
 * embeds the api key, the model's prior output, or the original spec prompt - only the
 * gate findings. (The `detail` of a g2 secret violation may contain a preview fragment;
 * that is fed back ONLY to the model that authored it, never logged - see generate().)
 */
export function buildValidationRepairPrompt(violations: ValidationViolation[]): string {
  const lines = [
    "Your previous bundle FAILED the platform validator and must be fixed.",
    "",
    "Problems to fix:",
    ...violations.map((v) => (v.file ? `- [${v.file}] ${v.detail}` : `- ${v.detail}`)),
  ];
  const touchesHandler = violations.some(
    (v) => v.file === "handler.ts" || v.detail.includes("handler.ts"),
  );
  if (touchesHandler) {
    lines.push(
      "",
      "handler.ts must export `async function handler(c: Context): Promise<Response>`.",
    );
  }
  lines.push(
    "",
    "Rewrite ONLY the files needed to fix these problems. Keep the exact five-file contract and stop.",
  );
  return lines.join("\n");
}

/**
 * Normalize the UNTRUSTED model temp-dir file tree into a Bundle with POSIX-style
 * relative keys (RESEARCH Pitfall 3: a Windows backslash key would fail the static
 * gate "missing file" check). Reads regular files under `dir` recursively, but
 * BOUNDED (WR-03): at most MAX_BUNDLE_FILES files, each at most
 * MAX_BUNDLE_FILE_BYTES, and only the BUNDLE_KEYS contract keys are ingested. An
 * over-large or extra-file model output is REJECTED here (throws) BEFORE any gate
 * runs, mirroring the scaffold path's exact-five enforcement. The Dockerfile key is
 * accepted (it is overwritten by the platform output downstream) but still counts
 * against the file/size caps.
 */
function readBundleFromDir(dir: string): Bundle {
  const bundle: Bundle = {};
  let count = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      // POSIX-normalize the key: relative to the root, forward slashes only.
      const key = relative(dir, abs).split(sep).join("/");
      // Reject anything outside the exact-five contract before reading it.
      if (!BUNDLE_KEY_SET.has(key)) {
        throw new Error(`claude bundle: unexpected file "${key}" (not a BUNDLE_KEYS file)`);
      }
      if (++count > MAX_BUNDLE_FILES) {
        throw new Error(`claude bundle: too many files (cap ${MAX_BUNDLE_FILES})`);
      }
      if (st.size > MAX_BUNDLE_FILE_BYTES) {
        throw new Error(
          `claude bundle: "${key}" is ${st.size} bytes, exceeds cap ${MAX_BUNDLE_FILE_BYTES}`,
        );
      }
      bundle[key] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return bundle;
}

/**
 * Assemble the final Bundle from the untrusted model temp dir: the bounded read
 * (readBundleFromDir) plus the two PLATFORM overwrites that the model never owns. The
 * Dockerfile is replaced with the digest-pinned generateDockerfile output (SBX-05, the
 * model's FROM line is discarded) and agent-card.json with the canonical A2A v0.3.0
 * card (the SAME buildAgentCard the scaffold uses, scaffold.ts:181). Factored out so
 * the generate() repair loop can RE-assemble after each repair pass: both overwrites
 * MUST run on every assembly so a re-validated bundle always carries the platform
 * Dockerfile + card, never the model placeholders (without this the model's placeholder
 * card fails G1 and every bundle is rejected).
 */
function assembleBundle(tmpDir: string, spec: ResourceSpec): Bundle {
  const bundle = readBundleFromDir(tmpDir);
  bundle["Dockerfile"] = generateDockerfile({
    runtime: spec.runtime,
    baseImage: PINNED_BASE_IMAGES[spec.runtime],
    registryUrl: process.env.REGISTRY_MIRROR_URL ?? "",
  });
  bundle["agent-card.json"] = JSON.stringify(buildAgentCard(spec), null, 2);
  return bundle;
}

/**
 * The live, operator-gated backend driven by @anthropic-ai/claude-agent-sdk. Needs
 * ANTHROPIC_API_KEY + network and is never the CI default. Constructing it performs
 * NO network call (config is stored only); the model is contacted solely inside
 * generate().
 */
export class ClaudeGenerator implements Generator {
  readonly backend = "claude" as const;
  private readonly config: ClaudeGeneratorConfig;

  constructor(config: ClaudeGeneratorConfig) {
    // Store config only - NO network call here (the selector must stay lazy).
    this.config = config;
  }

  async generate(spec: ResourceSpec): Promise<Bundle> {
    // Absolute temp cwd (ESM + Windows safe). The agent writes ONLY here. Cleaned up
    // in the finally below (IN-05) so repeated live generations do not leak temp
    // dirs full of untrusted model-authored source.
    const tmpDir = mkdtempSync(join(tmpdir(), "utter-gen-"));
    const systemPrompt = readSkill("system-prompt.md");

    try {
      // Drive the agent loop. Tools are constrained to file Write/Read; Bash and the
      // web are disallowed; no local Claude settings are inherited; the cwd is the
      // absolute temp dir. The model emits the five files into tmpDir.
      //
      // The SDK's `env` REPLACES the subprocess environment, so we spread
      // process.env (for PATH/HOME/etc) and inject the configured ANTHROPIC_API_KEY
      // (WR-02). This makes selectGenerator(env)'s key authoritative: the executor
      // honors the selector's key instead of silently depending on the ambient
      // process env, so the selector and executor agree on the key source.
      //
      // The closure shares ONE options object across both passes; only `prompt` and
      // `maxTurns` differ. The repair pass is NOT allowed to relax the sandbox:
      // allowedTools/disallowedTools/settingSources/cwd/env are identical.
      const runAgent = async (prompt: string, maxTurns: number): Promise<void> => {
        for await (const _msg of query({
          prompt,
          options: {
            model: this.config.model,
            systemPrompt,
            allowedTools: ["Write", "Read"],
            disallowedTools: ["Bash", "WebFetch", "WebSearch"],
            permissionMode: "acceptEdits",
            cwd: tmpDir,
            maxTurns,
            settingSources: [],
            env: { ...process.env, ANTHROPIC_API_KEY: this.config.apiKey },
          },
        })) {
          // Drain the iterator to run the agent loop to completion - the model output
          // is read back from the temp dir, never trusted from the message stream.
          void _msg;
        }
      };

      // First pass. maxTurns was 8, raised to 24: a five-file write plus reasoning
      // regularly exceeds 8 turns, and the model would stop having SKIPPED the
      // hardest file (handler.ts) - observed live as the g1/missing-file rejection.
      await runAgent(buildPrompt(spec), 24);

      // One-shot repair pass. If any required model-authored file is absent, re-enter
      // the SAME constrained loop ONCE to write only the missing files. This runs
      // EXACTLY ONCE: still-missing files fall through to readBundleFromDir (bounded
      // read) and the four 04-03 gates, which fail closed rather than looping. The
      // diagnostic logs ONLY the file-name array - never the prompt, model output, or
      // ANTHROPIC_API_KEY.
      const missing = findMissingModelFiles(tmpDir);
      if (missing.length > 0) {
        console.error(
          "claude generation: first pass missing files, running one repair pass",
          missing,
        );
        await runAgent(buildRepairPrompt(missing), 12);
      }

      // Validation-driven repair. Assemble the bundle and run the SAME four-gate
      // validateBundle the caller (live.ts) uses. If it fails on something the MODEL
      // authored (g1 shape / g2 static / g4 serve - not the platform-owned g3), feed
      // the EXACT gate violations back and let the model fix them, then re-assemble +
      // re-validate. Bounded by MAX_VALIDATION_REPAIRS so it NEVER loops: an
      // unrepairable bundle falls through to the caller's validateBundle (the FINAL
      // authority), which rejects it fail-closed. This does NOT weaken any gate - it
      // runs the gate MORE, never less, and the repair passes reuse the identical
      // sandboxed runAgent closure. This is what lets a model-fixable failure (e.g.
      // g1/test-cases-invalid) self-correct instead of dying at the first gate.
      let bundle = assembleBundle(tmpDir, spec);
      for (let attempt = 1; attempt <= MAX_VALIDATION_REPAIRS; attempt++) {
        const result = await validateBundle(bundle, spec);
        if (result.pass) break;
        const fixable = result.violations.filter(isModelRepairable);
        if (fixable.length === 0) break;
        // Log ONLY gate/kind ids - NEVER v.detail (a g2 secret detail carries a
        // preview), never the prompt, the model output, or the ANTHROPIC_API_KEY.
        console.error(
          "claude generation: validation failed, running repair pass",
          attempt,
          fixable.map((v) => `${v.gate}/${v.kind}`),
        );
        await runAgent(buildValidationRepairPrompt(fixable), 12);
        bundle = assembleBundle(tmpDir, spec);
      }

      return bundle;
    } finally {
      // Always remove the untrusted model temp tree, even on a gate/read throw.
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
