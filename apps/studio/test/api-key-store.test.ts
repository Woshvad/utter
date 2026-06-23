// api-key-store.test.ts - the durable, file-backed API-key store.
//
// FileApiKeyStore persists ONLY SHA-256 hashes (never raw keys) to disk, loads them on
// construct, and degrades to empty on a corrupt file. These tests use unique OS temp
// paths and clean them up so no .data artifact ever lands in the repo and suites stay
// hermetic.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileApiKeyStore } from "../app/auth/apikey.server";

const CREATOR = "0x1111111111111111111111111111111111111111";

/** Track temp dirs created in this suite so afterEach can remove them. */
const created: string[] = [];

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "utter-keystore-test-"));
  created.push(dir);
  return join(dir, "api-keys.json");
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FileApiKeyStore", () => {
  it("persists a minted key to disk and a fresh store (simulated restart) verifies it", async () => {
    const path = freshPath();
    const store = new FileApiKeyStore(path);
    const { raw } = await store.mintFor(CREATOR);
    expect(raw).toMatch(/^utk_/);

    // a SECOND store over the same path loads the persisted hash (restart) and verifies
    const restarted = new FileApiKeyStore(path);
    expect(await restarted.verifyFor(CREATOR, raw)).toBe(true);
    // a wrong key never verifies
    expect(await restarted.verifyFor(CREATOR, "utk_not-a-real-key")).toBe(false);
  });

  it("persists ONLY hashes - the raw key never appears on disk", async () => {
    const path = freshPath();
    const store = new FileApiKeyStore(path);
    const { raw } = await store.mintFor(CREATOR);

    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(raw);
    // the raw key body (minus the utk_ prefix) must not leak either
    expect(onDisk).not.toContain(raw.slice("utk_".length));
  });

  it("a corrupt file constructs empty without throwing", async () => {
    const path = freshPath();
    writeFileSync(path, "{ this is not valid json", "utf8");
    let store: FileApiKeyStore | undefined;
    expect(() => {
      store = new FileApiKeyStore(path);
    }).not.toThrow();
    // an empty store verifies nothing and lists nothing
    expect(await store!.verifyFor(CREATOR, "utk_anything")).toBe(false);
    expect(await store!.listHashes(CREATOR)).toEqual([]);
  });

  it("a missing file constructs empty without throwing", async () => {
    const path = freshPath(); // dir exists, file does not yet
    let store: FileApiKeyStore | undefined;
    expect(() => {
      store = new FileApiKeyStore(path);
    }).not.toThrow();
    expect(await store!.listHashes(CREATOR)).toEqual([]);
  });

  it("listHashes returns the stored hash, never the raw key", async () => {
    const path = freshPath();
    const store = new FileApiKeyStore(path);
    const { raw } = await store.mintFor(CREATOR);
    const hashes = await store.listHashes(CREATOR);
    expect(hashes.length).toBe(1);
    for (const h of hashes) {
      expect(h).not.toBe(raw);
      expect(h).not.toContain(raw);
      // a SHA-256 hex digest is 64 hex chars
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("resolveCreatorByKey maps a presented raw key back to its minting creator", async () => {
    const path = freshPath();
    const store = new FileApiKeyStore(path);
    const { raw } = await store.mintFor(CREATOR);

    expect(await store.resolveCreatorByKey(raw)).toBe(CREATOR);
    expect(await store.resolveCreatorByKey("utk_not-a-real-key")).toBeNull();
    expect(await store.resolveCreatorByKey("")).toBeNull();
  });

  it("multiple keys for the same creator all verify (and survive a restart)", async () => {
    const path = freshPath();
    const store = new FileApiKeyStore(path);
    const a = (await store.mintFor(CREATOR)).raw;
    const b = (await store.mintFor(CREATOR)).raw;

    const restarted = new FileApiKeyStore(path);
    expect(await restarted.verifyFor(CREATOR, a)).toBe(true);
    expect(await restarted.verifyFor(CREATOR, b)).toBe(true);
    expect((await restarted.listHashes(CREATOR)).length).toBe(2);
  });
});
