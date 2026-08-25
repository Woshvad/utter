// write.ts - materialize a FileMap (POSIX-keyed) to disk under a root directory. Keys are
// always "/"-separated (the generator builds them that way); we split + re-join with the OS
// separator so it is correct on Windows too. Optional prune removes named subdirectories
// before writing so a regenerate drops stale plugin folders.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FileMap } from "./types.js";

/**
 * Resolve a POSIX-keyed relative path to an absolute OS path under `rootDir`.
 *
 * Defense in depth (keys are ours today, sanitized to kebab upstream): split on BOTH separators
 * (`/` and `\`) so a Windows backslash `..` cannot slip through as one opaque segment, reject any
 * `..` segment, and, as a belt-and-suspenders final check, assert the resolved path stays under
 * the resolved root (this also catches absolute or drive-qualified keys). Runs correctly on
 * Windows and POSIX.
 */
function resolveKey(rootDir: string, key: string): string {
  const segments = key.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    throw new Error(`plugin-gen: refusing to write outside the root (key "${key}")`);
  }
  const abs = join(rootDir, ...segments);
  const rootResolved = resolve(rootDir);
  const absResolved = resolve(abs);
  if (absResolved !== rootResolved && !absResolved.startsWith(rootResolved + sep)) {
    throw new Error(`plugin-gen: refusing to write outside the root (key "${key}")`);
  }
  return abs;
}

/**
 * Write every file in `files` under `rootDir`. Creates parent directories as needed. When
 * `prune` is given, each listed (POSIX, relative) directory is removed first so regeneration
 * does not leave stale files behind. Returns the absolute paths written, sorted.
 */
export async function writeFiles(
  rootDir: string,
  files: FileMap,
  opts: { prune?: string[] } = {},
): Promise<string[]> {
  for (const dir of opts.prune ?? []) {
    await rm(resolveKey(rootDir, dir), { recursive: true, force: true });
  }
  const written: string[] = [];
  for (const [key, content] of Object.entries(files)) {
    const abs = resolveKey(rootDir, key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    written.push(abs);
  }
  return written.sort((a, b) => a.localeCompare(b));
}

/** Report a written path relative to root with POSIX separators (for logging). */
export function relPosix(rootDir: string, abs: string): string {
  const rel = abs.startsWith(rootDir) ? abs.slice(rootDir.length).replace(/^[\\/]+/, "") : abs;
  return rel.split(sep).join("/");
}
