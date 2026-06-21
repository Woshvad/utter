// The --import entry that registers the ESM resolve() hook.
//
// Wire this into a service start script as:
//   node --import ../../scripts/ts-resolver.mjs --experimental-strip-types src/server.ts
//
// register() is given an import.meta.url-relative URL so the hook is located
// regardless of the process working directory. This keeps the relative
// ../../scripts/ts-resolver.mjs in the facilitator start script correct even
// though pnpm runs that script with cwd = services/facilitator.

import { register } from "node:module";

register(new URL("./ts-resolver-hooks.mjs", import.meta.url));
