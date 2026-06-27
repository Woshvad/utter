import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// The React Router v7 framework-mode Vite plugin. Tailwind is wired in Plan 02
// (the token layer); this minimal config keeps the app building at the scaffold
// gate. Tests run via the package-local vitest.config.ts, not this file.
export default defineConfig({
  plugins: [reactRouter()],
  // Keep the docker/ssh cluster EXTERNAL to the SSR bundle. The studio's
  // live-deps.server.ts imports @utter/ai-runtime (selectGenerator + validateBundle), which
  // use real helpers from @utter/deployer + @utter/sandbox; those package barrels also
  // statically pull in the dockerode -> docker-modem -> ssh2 -> cpu-features orchestration
  // cluster, which the studio never executes (it deploys over HTTP to the deployer). That
  // cluster is CJS, ships a native addon (build/Release/cpufeatures.node), and uses
  // __dirname, so it can be NEITHER bundled into this ESM server (ReferenceError: __dirname
  // is not defined, from ssh2 crypto init) NOR have its .node binary resolved at build time.
  // So it stays external and loads as CJS at runtime (where __dirname is defined and
  // cpu-features is an optional try/catch require). pnpm's isolated layout would otherwise
  // hide these transitive deps from the studio server bundle, so the root .npmrc
  // public-hoist-pattern hoists them into the root node_modules to make the runtime
  // resolution succeed.
  //
  // @anthropic-ai/claude-agent-sdk is externalized for the SAME reason as the
  // docker/ssh cluster: its query() spawns the Claude Code CLI as a subprocess and
  // resolves that bundled CLI by __dirname, which a bundled ESM server breaks, so it
  // stays external and loads as a runtime require. It is a direct studio dependency
  // (pinned to match @utter/ai-runtime) so pnpm's isolated layout resolves it.
  ssr: {
    external: [
      "dockerode",
      "docker-modem",
      "ssh2",
      "cpu-features",
      "cpufeatures",
      "@anthropic-ai/claude-agent-sdk",
    ],
  },
});
