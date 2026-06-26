import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// The React Router v7 framework-mode Vite plugin. Tailwind is wired in Plan 02
// (the token layer); this minimal config keeps the app building at the scaffold
// gate. Tests run via the package-local vitest.config.ts, not this file.
export default defineConfig({
  plugins: [reactRouter()],
  // Externalize the docker/ssh native cluster from the SSR bundle. The studio's
  // live-deps.server.ts imports @utter/ai-runtime (selectGenerator/validateBundle),
  // and @utter/ai-runtime depends on @utter/deployer + @utter/sandbox, which pull
  // dockerode -> docker-modem -> ssh2 -> the optional cpu-features native addon
  // (build/Release/cpufeatures.node). The SSR build noExternals workspace packages,
  // so without this it tries to bundle that .node binary and fails to resolve it.
  // The studio never executes dockerode/ssh2 at runtime, so they stay runtime
  // requires here (cpu-features is optional and degrades gracefully if loaded).
  ssr: {
    external: ["dockerode", "docker-modem", "ssh2", "cpu-features", "cpufeatures"],
  },
});
