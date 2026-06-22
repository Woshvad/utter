// PostCSS config so Vite runs Tailwind over the entry stylesheet at build time.
// ESM (the package is type:module). Tailwind v3 registers its PostCSS plugin
// under the `tailwindcss` key (v4 moved it to `@tailwindcss/postcss`); we are on
// v3, so the v3 key is correct. Vite bundles its own PostCSS runner, so neither
// `postcss` nor `autoprefixer` is added as a dependency - modern build targets do
// not need vendor prefixes.
export default {
  plugins: {
    tailwindcss: {},
  },
};
