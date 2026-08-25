// write.test.ts - the fs writer materializes a FileMap faithfully (nested dirs, prune,
// path-escape guard). Uses a throwaway temp dir under the OS temp root.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFiles, relPosix } from "../src/write.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "utter-plugin-gen-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("writeFiles", () => {
  it("writes every file, creating nested directories, and reads back identical content", async () => {
    const root = await tmp();
    const files = {
      ".claude-plugin/marketplace.json": '{"name":"utter"}\n',
      "plugins/utter-buyer/.claude-plugin/plugin.json": '{"name":"utter-buyer"}\n',
      "plugins/utter-buyer/skills/using-utter/SKILL.md": "---\nname: using-utter\n---\nbody\n",
    };
    const written = await writeFiles(root, files);
    expect(written.length).toBe(3);
    for (const [key, content] of Object.entries(files)) {
      const back = await readFile(join(root, ...key.split("/")), "utf8");
      expect(back).toBe(content);
    }
    expect(relPosix(root, written[0]!)).toMatch(/^\.claude-plugin|^plugins/);
  });

  it("prune removes a stale plugin dir before writing", async () => {
    const root = await tmp();
    // Seed a stale plugin.
    await mkdir(join(root, "plugins", "utter-old"), { recursive: true });
    await writeFile(join(root, "plugins", "utter-old", "x.txt"), "stale", "utf8");
    await writeFiles(root, { "plugins/utter-new/.claude-plugin/plugin.json": "{}\n" }, { prune: ["plugins"] });
    // Old gone, new present.
    await expect(readFile(join(root, "plugins", "utter-old", "x.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, "plugins", "utter-new", ".claude-plugin", "plugin.json"), "utf8")).toBe("{}\n");
  });

  it("refuses a key that escapes the root (POSIX and Windows backslash forms)", async () => {
    const root = await tmp();
    await expect(writeFiles(root, { "../evil.txt": "x" })).rejects.toThrow(/outside the root/);
    // Windows backslash traversal must be decomposed and blocked too (the build platform).
    await expect(writeFiles(root, { "..\\..\\evil.txt": "x" })).rejects.toThrow(/outside the root/);
    await expect(writeFiles(root, { "sub\\..\\..\\..\\evil.txt": "x" })).rejects.toThrow(/outside the root/);
  });
});
