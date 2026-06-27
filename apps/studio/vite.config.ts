import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// The React Router v7 framework-mode Vite plugin. Tailwind is wired in Plan 02
// (the token layer); this minimal config keeps the app building at the scaffold
// gate. Tests run via the package-local vitest.config.ts, not this file.
export default defineConfig({
  plugins: [reactRouter()],
  // Keep ONLY the optional native CPU-feature addon out of the SSR bundle, and BUNDLE
  // the pure-JS docker/ssh cluster. The studio's live-deps.server.ts imports
  // @utter/ai-runtime (selectGenerator/validateBundle), and @utter/ai-runtime depends on
  // @utter/deployer + @utter/sandbox, which pull dockerode -> docker-modem -> ssh2 -> the
  // OPTIONAL cpu-features native addon (build/Release/cpufeatures.node). The SSR build
  // noExternals the workspace packages, so dockerode/docker-modem/ssh2 are inlined into
  // build/server/index.js; only cpu-features stays external so the bundler never tries to
  // resolve the .node binary (ssh2 loads cpu-features lazily in a try/catch and degrades
  // when it is absent). We must NOT externalize dockerode/ssh2 themselves: under pnpm's
  // isolated node_modules the production server bundle cannot resolve a runtime
  // `import "dockerode"` (a transitive dep the studio never executes - deploys go over HTTP
  // to the deployer), which crashes the container at boot. Bundling them removes that import.
  ssr: {
    external: ["cpu-features", "cpufeatures"],
  },
});
