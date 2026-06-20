// scanImports - the dangerous-import / dangerous-API AST deny-list scan
// (SBX-06b; RESEARCH Pattern 6).
//
// Walks a bundle's TS/JS source with the TypeScript compiler API and flags:
//   - imports / requires / dynamic imports of a deny-listed module
//     (child_process, net, dgram, cluster, worker_threads) - raw sockets,
//     subprocess spawn, datagram, multi-process escape hatches;
//   - `fs` reads of /proc or /sys (host-introspection paths);
//   - `process.env` enumeration (Object.keys/values/entries/for-in over the
//     whole env, or spreading it) - the platform-secret exfil vector.
//
// This is a STATIC analyzer: it reads source text, it NEVER imports or executes
// the bundle. It runs autonomously (no isolation host). A violation FAILS
// publication (combined with scanSecrets in runPrePublishStaticChecks).
import ts from "typescript";

/** The deny-listed Node modules - their import is a publication-failing violation. */
export const DISALLOWED_IMPORTS = [
  "child_process",
  "net",
  "dgram",
  "cluster",
  "worker_threads",
] as const;

/** Node import specifiers also disallowed under the `node:` prefix. */
const NODE_PREFIXED = new Set(DISALLOWED_IMPORTS.map((m) => `node:${m}`));

/** A single static-scan finding. */
export interface ImportViolation {
  /** The rule that fired. */
  rule:
    | "disallowed-import"
    | "fs-proc-sys-read"
    | "process-env-enumeration";
  /** A human-readable description of the finding. */
  message: string;
  /** 1-based line number of the offending node (best-effort). */
  line: number;
}

/** Is `spec` a deny-listed module specifier? */
function isDisallowedModule(spec: string): boolean {
  return (DISALLOWED_IMPORTS as readonly string[]).includes(spec) || NODE_PREFIXED.has(spec);
}

/** 1-based line for a node in its source file. */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Scan one source string for dangerous imports / APIs. Returns every violation
 * (empty array == clean). Pure + synchronous; reads source text only.
 */
export function scanImports(source: string, fileName = "bundle.ts"): ImportViolation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: ImportViolation[] = [];

  const flag = (rule: ImportViolation["rule"], message: string, node: ts.Node): void => {
    violations.push({ rule, message, line: lineOf(sf, node) });
  };

  const visit = (node: ts.Node): void => {
    // 1a. static `import ... from "net"`
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (isDisallowedModule(spec)) {
        flag("disallowed-import", `disallowed import of "${spec}"`, node);
      }
    }

    // 1b. `import foo = require("net")` (TS import-equals)
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const spec = node.moduleReference.expression.text;
      if (isDisallowedModule(spec)) {
        flag("disallowed-import", `disallowed import = require("${spec}")`, node);
      }
    }

    // 1c. `require("net")` and dynamic `import("net")`
    if (ts.isCallExpression(node)) {
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg) && isDisallowedModule(arg.text)) {
          flag(
            "disallowed-import",
            `disallowed ${isRequire ? "require" : "dynamic import"}("${arg.text}")`,
            node,
          );
        }
      }
    }

    // 2. `fs` reads of /proc or /sys (host introspection) - a string-literal
    //    argument that begins with /proc or /sys inside any call expression.
    if (ts.isStringLiteral(node)) {
      const v = node.text;
      if (v.startsWith("/proc") || v.startsWith("/sys")) {
        flag("fs-proc-sys-read", `host-path access to "${v}" (/proc|/sys)`, node);
      }
    }

    // 3. process.env enumeration: Object.keys/values/entries(process.env),
    //    a for-in over process.env, or spreading {...process.env}.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const fn = node.expression;
      const isObjectEnumerator =
        ts.isIdentifier(fn.expression) &&
        fn.expression.text === "Object" &&
        ["keys", "values", "entries", "assign"].includes(fn.name.text);
      if (isObjectEnumerator && node.arguments.some(isProcessEnv)) {
        flag("process-env-enumeration", "Object enumeration over process.env", node);
      }
    }
    if (ts.isForInStatement(node) && isProcessEnv(node.expression)) {
      flag("process-env-enumeration", "for-in enumeration over process.env", node);
    }
    if (ts.isSpreadAssignment(node) && isProcessEnv(node.expression)) {
      flag("process-env-enumeration", "spread of process.env", node);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

/** Is `expr` the `process.env` member-access expression? */
function isProcessEnv(expr: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "process" &&
    expr.name.text === "env"
  );
}
