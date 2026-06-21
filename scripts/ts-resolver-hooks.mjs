// No-dependency ESM resolve() hook for native Node.
//
// The Utter monorepo uses extensionless relative imports (for example
// `from "./arc"`), which are fine under vitest/esbuild but illegal in native
// Node ESM, where relative specifiers must carry an explicit extension. This
// hook bridges the gap by appending ".ts" and then "/index.ts" to extensionless
// relative specifiers, so `node --experimental-strip-types` can run service
// entrypoints without a codebase-wide extension sweep.
//
// Node builtins only. Bare specifiers, builtins, and already-extensioned
// specifiers pass straight through to nextResolve untouched.

// Matches a trailing js/ts/mjs/cjs/mts/cts extension.
const HAS_JS_TS_EXT = /\.(m|c)?(j|t)s$/;

export async function resolve(specifier, context, nextResolve) {
  // Bare specifiers and builtins (for example @utter/chain, viem, node:fs):
  // pass through unchanged. We do not catch errors here.
  if (!specifier.startsWith(".")) {
    return await nextResolve(specifier, context);
  }

  // A relative ".js" specifier (for example ./foo.js): this is the TypeScript
  // ESM convention where the SOURCE is ./foo.ts but the import carries the emitted
  // ".js" extension. Under native --experimental-strip-types there is no emitted
  // ".js" sibling, so first try the ".ts" source. Only the resolution error from
  // this attempt is caught; on miss we fall back to the original ".js" specifier so
  // Node still produces its normal, accurate error (we never mask a real failure).
  if (specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch {
      return await nextResolve(specifier, context);
    }
  }

  // Already-extensioned relative specifiers (for example ./foo.ts, ./data.json):
  // pass through unchanged. We do not catch errors here.
  if (HAS_JS_TS_EXT.test(specifier) || specifier.endsWith(".json")) {
    return await nextResolve(specifier, context);
  }

  // Extensionless relative specifier. First try the ".ts" sibling. Only the
  // resolution error from this specific attempt is caught.
  try {
    return await nextResolve(specifier + ".ts", context);
  } catch (tsError) {
    // The ".ts" sibling did not resolve. Try the "/index.ts" directory form.
    try {
      return await nextResolve(specifier + "/index.ts", context);
    } catch (indexError) {
      // Neither append worked. Fall through to the original specifier so Node
      // produces its normal, accurate ERR_MODULE_NOT_FOUND. We never mask the
      // real failure with our synthetic attempts.
      return await nextResolve(specifier, context);
    }
  }
}
