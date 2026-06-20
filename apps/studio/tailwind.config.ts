import type { Config } from "tailwindcss";

// Tailwind theme.extend for Utter Studio. Every value references a CSS variable
// from app/styles/tokens.css (the dark-Bauhaus token layer) via `var(--token)` -
// there is NO raw hex here and none in any component; utilities resolve the vars.
//
// Geometry: radius 0 by default (hard-edged Bauhaus); the only rounded exception is
// `rounded-full` (perfect circles for the circle status motif / avatars). Type:
// Space Grotesk display + JetBrains Mono for ALL money / counts / hashes / code.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)",
        raised: "var(--raised)",
        hairline: "var(--hairline)",
        ink: "var(--ink)",
        "ink-muted": "var(--ink-muted)",
        "ink-faint": "var(--ink-faint)",
        "paper-bg": "var(--paper-bg)",
        "paper-ink": "var(--paper-ink)",
        red: "var(--red)",
        blue: "var(--blue)",
        yellow: "var(--yellow)",
        g1: "var(--g1)",
        g2: "var(--g2)",
        g3: "var(--g3)",
        g4: "var(--g4)",
        g5: "var(--g5)",
        g6: "var(--g6)",
      },
      backgroundColor: {
        scrim: "var(--scrim)",
      },
      borderColor: {
        hairline: "var(--hairline)",
      },
      fontFamily: {
        // display = Space Grotesk; mono = JetBrains Mono (all money/code/addresses)
        display: "var(--font-display)",
        mono: "var(--font-mono)",
        sans: "var(--font-display)",
      },
      fontSize: {
        // Core dense-surface roles (UI-SPEC: exactly 4 sizes / 2 weights)
        body: ["0.875rem", { lineHeight: "1.5" }],
        label: ["0.875rem", { lineHeight: "1.2" }],
        heading: ["1.25rem", { lineHeight: "1.2" }],
        display: ["1.75rem", { lineHeight: "1.1" }],
        // Mono numerics / captions (addresses, hashes, table numbers, timestamps)
        "caption-mono": ["0.75rem", { lineHeight: "1.4" }],
        // Larger Bauhaus scale steps - landing / data-viz ONLY (not dense surfaces)
        "display-sm": ["2rem", { lineHeight: "1.05" }],
        "display-lg": ["3rem", { lineHeight: "1.0" }],
        hero: ["4.5rem", { lineHeight: "0.95" }],
        mega: ["6rem", { lineHeight: "0.95" }],
      },
      letterSpacing: {
        tight: "-0.02em",
        tighter: "-0.03em",
      },
      borderRadius: {
        // hard-edged default; circles use Tailwind's built-in `rounded-full`
        none: "0px",
        DEFAULT: "var(--radius)",
      },
      spacing: {
        // App-shell layout constants (UI-SPEC exceptions)
        sidebar: "240px",
        topbar: "64px",
        topbarwide: "72px",
      },
      maxWidth: {
        content: "1320px",
        "content-dense": "1200px",
      },
      keyframes: {
        utterPulse: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
        utterSnap: {
          "0%": { transform: "scale(0.7)", opacity: "0" },
          "60%": { transform: "scale(1.06)" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        utterFill: {
          "0%": { clipPath: "inset(100% 0 0 0)" },
          "100%": { clipPath: "inset(0 0 0 0)" },
        },
        utterBar: {
          "0%": { transform: "translateX(-101%)" },
          "100%": { transform: "translateX(0)" },
        },
        utterBlink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0" } },
      },
      animation: {
        "utter-pulse": "utterPulse 1s infinite",
        "utter-snap": "utterSnap 0.22s ease-out",
        "utter-fill": "utterFill 0.5s ease-out",
        "utter-bar": "utterBar 0.22s ease-out",
        "utter-blink": "utterBlink 1s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
