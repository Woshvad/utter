import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// The React Router v7 framework-mode Vite plugin. Tailwind is wired in Plan 02
// (the token layer); this minimal config keeps the app building at the scaffold
// gate. Tests run via the package-local vitest.config.ts, not this file.
export default defineConfig({
  plugins: [reactRouter()],
});
