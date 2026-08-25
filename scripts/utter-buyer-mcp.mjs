// utter-buyer-mcp.mjs - a Windows-safe launcher for the buyer MCP stdio server, used by the
// generated Claude Code plugins (packages/plugin-gen -> localMcp()).
//
// Why a launcher and not `node --import <abs>/scripts/ts-resolver.mjs ... mcp.ts` directly:
// on Windows, `node --import C:\...` throws ERR_UNSUPPORTED_ESM_URL_SCHEME (the absolute path
// is parsed as a `c:` URL). The MAIN script argument, by contrast, accepts a Windows absolute
// path fine. So the plugin runs THIS file as the main entry (via ${CLAUDE_PROJECT_DIR}), and
// it registers the TS resolve hook using an import.meta.url-relative URL (also Windows-safe),
// then imports the buyer MCP bin. Type stripping is on by default in Node 24; the plugin also
// passes --experimental-strip-types for older Node.
//
// ZERO stdout writes here (stdout is the JSON-RPC frame channel the bin owns). Any diagnostic
// goes to stderr.
import { register } from "node:module";

register(new URL("./ts-resolver-hooks.mjs", import.meta.url));

await import(new URL("../packages/buyer-sdk/src/bin/mcp.ts", import.meta.url));
