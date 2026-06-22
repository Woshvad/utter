// The one-command dev runner. `pnpm dev` (or `node scripts/dev.mjs`) at the repo
// root starts the studio with a single command, and ALSO starts the facilitator
// when a relayer signer key is present. It is spawn-glue only: it shells out to
// the existing per-package dev/start scripts, it does not inline any service.
//
// Behavior:
//   1. Load the root .env.local first (mirroring services/facilitator/src/server.ts)
//      so the spawned children inherit the parsed vars via process.env.
//   2. ALWAYS start the studio (pnpm --filter @utter/studio dev).
//   3. Start the facilitator ONLY when RELAYER_SIGNER_KEYS is present and non-empty;
//      otherwise print one friendly line and run studio only. Never crash, never
//      print the key value itself (it is a real private key).
//
// node builtins + the existing dotenv devDep only. No new npm package.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

// Resolve the repo root from this file (scripts/dev.mjs -> repo root) so .env.local
// loads regardless of the cwd the runner was invoked from.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Load the root .env.local first so both children inherit the parsed vars. This
// mirrors the facilitator bootstrap; a missing file is a no-op (dotenv is quiet).
loadEnv({ path: resolve(repoRoot, ".env.local") });

// Live-studio wiring (dev-machine). When an ANTHROPIC_API_KEY is staged (the operator
// wants real AI generation), default the studio to the LIVE adapter so `utter a sentence`
// generates for real, AND isolate the Agent SDK's config dir to a fresh empty dir so it
// authenticates with ANTHROPIC_API_KEY instead of this machine's interactive Claude Code
// subscription OAuth (a dev-only collision that 401s the SDK; a server with only the key
// set never hits it - see memory live-generation-dev-run). An explicitly-set
// STUDIO_DATA_ADAPTER / CLAUDE_CONFIG_DIR is always honored. The key value is never logged.
const childEnv = { ...process.env };
const haveAnthropicKey = (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
if (haveAnthropicKey) {
  if (!childEnv.STUDIO_DATA_ADAPTER) childEnv.STUDIO_DATA_ADAPTER = "live";
  if (!childEnv.CLAUDE_CONFIG_DIR) {
    childEnv.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "utter-agent-cfg-"));
  }
}

// shell:true so the `pnpm` shim resolves on Windows (the builder runs Windows 11;
// this also runs under WSL2). stdio:inherit forwards each child's output directly.
const spawnOpts = { stdio: "inherit", shell: true, env: childEnv, cwd: repoRoot };

/** The live child handles, so SIGINT/SIGTERM can forward the signal to each. */
const children = [];

/** Spawn a workspace script and track its handle. */
function startChild(label, args) {
  const child = spawn("pnpm", args, spawnOpts);
  children.push(child);
  // If a child dies, do not leave the runner hanging: tear the rest down too.
  child.on("exit", (code, signal) => {
    console.log(`${label} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
    shutdown(signal ?? "SIGTERM");
  });
  return child;
}

let shuttingDown = false;

/** Forward a termination signal to every live child, then exit. */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  }
  process.exit(0);
}

// (2) ALWAYS start the studio.
startChild("studio", ["--filter", "@utter/studio", "dev"]);
console.log("studio dev starting on http://localhost:3000 (react-router dev default)");
console.log(
  childEnv.STUDIO_DATA_ADAPTER === "live"
    ? "studio adapter: LIVE - real AI generation on (ANTHROPIC_API_KEY staged; Agent SDK config dir isolated)"
    : "studio adapter: fixture - set ANTHROPIC_API_KEY in .env.local for real AI generation",
);

// (3) Start the facilitator only when a relayer key is present and non-empty.
// Trim and check length (mirroring the server.ts fail-fast); never print the value.
const relayerKeys = (process.env.RELAYER_SIGNER_KEYS ?? "").trim();
if (relayerKeys.length > 0) {
  startChild("facilitator", ["--filter", "@utter/facilitator", "start"]);
  console.log("facilitator starting on http://localhost:8787 (server.ts PORT default)");
} else {
  console.log(
    "facilitator skipped: set RELAYER_SIGNER_KEYS in .env.local to also start it (running studio only)",
  );
}

// (4) ALWAYS start the deployer and marketplace control planes. They boot with the
// in-memory store defaults and read no secrets, so they need no env gate. startChild
// already tracks each handle and tears the rest down if one dies, so the existing
// clean-kill-all on SIGINT/SIGTERM covers them too.
startChild("deployer", ["--filter", "@utter/deployer", "start"]);
console.log("deployer starting on http://localhost:8788 (server.ts PORT default)");

startChild("marketplace", ["--filter", "@utter/marketplace", "start"]);
console.log("marketplace starting on http://localhost:8789 (server.ts PORT default)");

// Kill children cleanly on Ctrl-C / terminate.
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
