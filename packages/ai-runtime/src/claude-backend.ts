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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { generateDockerfile, PINNED_BASE_IMAGES } from "@utter/deployer";
import { DEFAULT_MAX_RESPONSE_BYTES } from "@utter/sandbox";
import type { Generator } from "./generator.js";
import { buildAgentCard } from "./agent-card.js";
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
      for await (const _msg of query({
        prompt: buildPrompt(spec),
        options: {
          model: this.config.model,
          systemPrompt,
          allowedTools: ["Write", "Read"],
          disallowedTools: ["Bash", "WebFetch", "WebSearch"],
          permissionMode: "acceptEdits",
          cwd: tmpDir,
          maxTurns: 8,
          settingSources: [],
          env: { ...process.env, ANTHROPIC_API_KEY: this.config.apiKey },
        },
      })) {
        // Drain the iterator to run the agent loop to completion - the model output
        // is read back from the temp dir, never trusted from the message stream.
        void _msg;
      }

      const bundle = readBundleFromDir(tmpDir);

      // OVERWRITE the Dockerfile with the platform-produced, digest-pinned output -
      // exactly as the scaffold does. The model never authors the FROM line (SBX-05).
      bundle["Dockerfile"] = generateDockerfile({
        runtime: spec.runtime,
        baseImage: PINNED_BASE_IMAGES[spec.runtime],
        registryUrl: process.env.REGISTRY_MIRROR_URL ?? "",
      });

      // OVERWRITE agent-card.json with the canonical A2A v0.3.0 card. The contract
      // (system-prompt.md / bundle-contract.md) tells the model to emit a minimal
      // PLACEHOLDER card because the platform owns the real one - exactly as it owns
      // the Dockerfile. buildAgentCard is the SAME builder the scaffold uses
      // (scaffold.ts:181), so the live and scaffold paths produce an identical,
      // G1-valid card. Without this the model's placeholder fails the 04-03 G1 A2A
      // validation and every live bundle is rejected.
      bundle["agent-card.json"] = JSON.stringify(buildAgentCard(spec), null, 2);

      return bundle;
    } finally {
      // Always remove the untrusted model temp tree, even on a gate/read throw.
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
