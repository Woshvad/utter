// helpers.ts - tiny test utilities: parse a SKILL.md/command frontmatter block + the shape
// checks the schema tests assert against. No YAML dep: the generator emits a flat, quoted
// frontmatter, so a line parser is sufficient and keeps the package dependency-free.
import { expect } from "vitest";

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/** Parse a leading `---` frontmatter block into flat string fields + the remaining body. */
export function parseFrontmatter(md: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error("no frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // Unwrap a double-quoted scalar (the generator quotes description/argument-hint).
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    fields[kv[1]!] = value;
  }
  return { fields, body: m[2] ?? "" };
}

/** Assert a name is a valid Claude Code kebab identifier. */
export function expectKebab(name: string): void {
  expect(name, `"${name}" must be kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
}

/** Parse the plugin.json from a plugin file map. */
export function pluginManifest(files: Record<string, string>): Record<string, unknown> {
  const raw = files[".claude-plugin/plugin.json"];
  expect(raw, "plugin.json present").toBeTruthy();
  return JSON.parse(raw!) as Record<string, unknown>;
}
