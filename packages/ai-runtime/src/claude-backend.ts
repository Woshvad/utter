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
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { generateDockerfile, PINNED_BASE_IMAGES } from "@utter/deployer";
import type { Generator } from "./generator.js";
import { type Bundle, type ResourceSpec } from "./types.js";

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

/**
 * Normalize a temp-dir file tree into a Bundle with POSIX-style relative keys
 * (RESEARCH Pitfall 3: a Windows backslash key would fail the static gate "missing
 * file" check). Reads every regular file under `dir` recursively.
 */
function readBundleFromDir(dir: string): Bundle {
  const bundle: Bundle = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      // POSIX-normalize the key: relative to the root, forward slashes only.
      const key = relative(dir, abs).split(sep).join("/");
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
    // Absolute temp cwd (ESM + Windows safe). The agent writes ONLY here.
    const tmpDir = mkdtempSync(join(tmpdir(), "utter-gen-"));
    const systemPrompt = readSkill("system-prompt.md");

    // Drive the agent loop. Tools are constrained to file Write/Read; Bash and the
    // web are disallowed; no local Claude settings are inherited; the cwd is the
    // absolute temp dir. The model emits the five files into tmpDir.
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
      },
    })) {
      // Drain the async iterator for logging only - the model output is read back
      // from the temp dir, never trusted from the message stream.
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

    return bundle;
  }
}
