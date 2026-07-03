// keys-cap.test.ts - the per-creator API-key mint cap (S8).
//
// Covers: FileApiKeyStore.mintFor throws the typed ApiKeyCapError at the cap
// (nothing minted or persisted for the over-cap request), the cap is per creator,
// the env knob feeds the default, and the /keys action surfaces the message as an
// inline error payload instead of a raw 500.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileApiKeyStore, ApiKeyCapError } from "../app/auth/apikey.server";

const CREATOR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

let dir: string;

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.API_KEYS_PER_CREATOR_MAX;
});

function tempPath(): string {
  dir = mkdtempSync(join(tmpdir(), "utter-keys-cap-"));
  return join(dir, "keys.json");
}

/** Commit a session for the given address and return its Cookie header value. */
async function sessionCookie(address: string): Promise<string> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

describe("FileApiKeyStore per-creator cap (S8)", () => {
  it("mints up to the cap, then throws the typed ApiKeyCapError", async () => {
    const store = new FileApiKeyStore(tempPath(), { maxKeysPerCreator: 2 });
    await store.mintFor(CREATOR);
    await store.mintFor(CREATOR);
    await expect(store.mintFor(CREATOR)).rejects.toBeInstanceOf(ApiKeyCapError);
    await expect(store.mintFor(CREATOR)).rejects.toThrow(/api key limit reached \(2 keys/);
    // Nothing extra was persisted for the refused mint.
    expect((await store.listHashes(CREATOR)).length).toBe(2);
  });

  it("the cap is per creator: another creator still mints", async () => {
    const store = new FileApiKeyStore(tempPath(), { maxKeysPerCreator: 1 });
    await store.mintFor(CREATOR);
    await expect(store.mintFor(CREATOR)).rejects.toBeInstanceOf(ApiKeyCapError);
    await expect(store.mintFor(OTHER)).resolves.toMatchObject({
      raw: expect.stringMatching(/^utk_/) as string,
    });
  });

  it("reads the default cap from API_KEYS_PER_CREATOR_MAX", async () => {
    process.env.API_KEYS_PER_CREATOR_MAX = "1";
    const store = new FileApiKeyStore(tempPath());
    await store.mintFor(CREATOR);
    await expect(store.mintFor(CREATOR)).rejects.toBeInstanceOf(ApiKeyCapError);
  });

  it("carries the typed code", async () => {
    const store = new FileApiKeyStore(tempPath(), { maxKeysPerCreator: 1 });
    await store.mintFor(CREATOR);
    try {
      await store.mintFor(CREATOR);
      expect.unreachable("mintFor must throw at cap");
    } catch (err) {
      expect((err as ApiKeyCapError).code).toBe("api_key_cap");
    }
  });
});

describe("/keys action surfaces the cap (no raw 500)", () => {
  it("returns { mintedRaw: null, error } when the store refuses", async () => {
    const { apiKeyStore } = await import("../app/auth/apiKeyStore.server");
    const spy = vi
      .spyOn(apiKeyStore, "mintFor")
      .mockRejectedValueOnce(new ApiKeyCapError(50));

    const { action } = await import("../app/routes/keys");
    const result = await action({
      request: new Request("http://localhost/keys", {
        method: "POST",
        headers: { Cookie: await sessionCookie(CREATOR) },
      }),
      params: {},
      context: {},
    } as never);

    expect(result.mintedRaw).toBeNull();
    expect(result.error).toMatch(/api key limit reached/);
    spy.mockRestore();
  });

  it("still returns the shown-once raw on a normal mint", async () => {
    const { action } = await import("../app/routes/keys");
    const result = await action({
      request: new Request("http://localhost/keys", {
        method: "POST",
        headers: { Cookie: await sessionCookie(CREATOR) },
      }),
      params: {},
      context: {},
    } as never);

    expect(result.error).toBeNull();
    expect(result.mintedRaw).toMatch(/^utk_/);
  });
});
