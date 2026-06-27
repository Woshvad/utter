// handler.ts - the TYPE-STUB sibling for the trusted generated-server-shim's `./handler`
// import (deploy plane B). This is NOT a real handler and is NEVER bundled or executed.
//
// The shim (generated-server-shim.ts) imports `./handler` (the generated handler's named
// export per packages/ai-runtime/skills/templates/handler.ts.tmpl). At deploy time the
// shim is written into the bundle dir beside the GENERATED handler.ts, so esbuild resolves
// `./handler` to the real generated handler. At deployer TYPECHECK time, `./handler`
// resolves to THIS stub, giving tsc the exact contract the shim depends on (the template's
// `export async function handler(c: Context): Promise<Response>`).
//
// Keeping this stub minimal and side-effect-free means even if it were ever bundled by
// mistake it would only ever 501; the real generated handler always shadows it at deploy.
import type { Context } from "hono";

/**
 * The generated-handler contract: a plain Hono handler returning a Response. This stub
 * exists ONLY to satisfy the shim's typecheck; the real generated handler replaces it at
 * deploy time. It returns 501 to make an accidental bundling obvious rather than silent.
 */
export async function handler(_c: Context): Promise<Response> {
  return new Response(
    JSON.stringify({ error: "generated handler not bundled", code: "NOT_BUNDLED" }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}
