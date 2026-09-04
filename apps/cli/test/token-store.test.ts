import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileTokenStore, createKeyringTokenStore, type KeyringTokenBackend } from "../src/token-store.js";

test("file token store scopes tokens by normalized API URL", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myskills-token-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "tokens.json");
  const store = createFileTokenStore({ MYSKILLS_TOKEN_FILE: tokenFile });

  await store.set("http://api.test/", {
    kind: "session",
    token: "stored-session",
    email: "owner@example.com",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });

  assert.deepEqual(await store.get("http://api.test"), {
    kind: "session",
    token: "stored-session",
    email: "owner@example.com",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(await store.get("http://other.test"), null);
  assert.equal(JSON.parse(await readFile(tokenFile, "utf8")).tokens["http://api.test"].token, "stored-session");
  if (process.platform !== "win32") {
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  }

  await store.delete("http://api.test/");

  assert.equal(await store.get("http://api.test"), null);
});

test("malformed file errors never include an excerpt of a credential", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myskills-token-store-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "tokens.json");
  const secretFixture = "private-token-fixture-do-not-echo";
  await writeFile(tokenFile, secretFixture);
  const store = createFileTokenStore({ MYSKILLS_TOKEN_FILE: tokenFile });
  await assert.rejects(store.get(API_URL), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid JSON/);
    assert.equal(error.message.includes(secretFixture), false);
    return true;
  });
});

test("keyring reads use the file only for a confirmed missing credential and report that backend", async (t) => {
  const { fallback, backend, store } = await fixture(t);
  await fallback.set(API_URL, OLD_TOKEN);
  assert.deepEqual(await store.get(API_URL), OLD_TOKEN);
  assert.equal((await store.describe!()).backend, "file");
  backend.raw = JSON.stringify(NEW_TOKEN);
  assert.deepEqual(await store.get(API_URL), NEW_TOKEN);
  assert.equal((await store.describe!()).backend, "keyring");
  backend.failure = "get";
  await assert.rejects(store.get(API_URL), /Cannot read the OS keyring/);
  backend.failure = null;
  backend.raw = "invalid credential format";
  await assert.rejects(store.get(API_URL), /invalid format/);
});

test("failed keyring writes never save a new fallback that an older keyring token can shadow", async (t) => {
  const { fallback, backend, store } = await fixture(t);
  backend.raw = JSON.stringify(OLD_TOKEN);
  backend.failure = "set";
  await assert.rejects(store.set(API_URL, NEW_TOKEN), /Cannot save the token/);
  assert.equal(await fallback.get(API_URL), null);
  backend.failure = null;
  assert.deepEqual(await store.get(API_URL), OLD_TOKEN);
});

test("successful keyring writes remove a superseded fallback", async (t) => {
  const { fallback, backend, store } = await fixture(t);
  await fallback.set(API_URL, OLD_TOKEN);
  await store.set(API_URL, NEW_TOKEN);
  assert.deepEqual(await store.get(API_URL), NEW_TOKEN);
  assert.equal(await fallback.get(API_URL), null);
  backend.raw = null;
  assert.equal(await store.get(API_URL), null);
});

test("logout cleans the fallback but reports keyring deletion failure", async (t) => {
  const { fallback, backend, store } = await fixture(t);
  await fallback.set(API_URL, OLD_TOKEN);
  backend.raw = JSON.stringify(NEW_TOKEN);
  backend.failure = "delete";
  await assert.rejects(store.delete(API_URL), /Logout cleanup is incomplete.*OS keyring/);
  assert.equal(await fallback.get(API_URL), null);
  assert.equal(backend.raw, JSON.stringify(NEW_TOKEN));
  backend.failure = null;
  await store.delete(API_URL);
  await store.delete(API_URL);
  assert.equal(await store.get(API_URL), null);
});

test("file cleanup failures are visible after keyring save or logout", async (t) => {
  const { fallback, backend } = await fixture(t);
  const store = createKeyringTokenStore({
    ...fallback,
    async delete() { throw new Error("injected file cleanup failure"); },
  }, backend);
  await assert.rejects(store.set(API_URL, NEW_TOKEN), /saved in the OS keyring.*cleanup is incomplete/);
  assert.equal(backend.raw, JSON.stringify(NEW_TOKEN));
  await assert.rejects(store.delete(API_URL), /Logout cleanup is incomplete.*file/);
  assert.equal(backend.raw, null);
});

const API_URL = "https://registry.example.test";
const OLD_TOKEN = { kind: "api" as const, token: "old-test-token", email: undefined, expiresAt: undefined };
const NEW_TOKEN = { kind: "api" as const, token: "new-test-token", email: undefined, expiresAt: undefined };

class FakeKeyring implements KeyringTokenBackend {
  raw: string | null = null;
  failure: "get" | "set" | "delete" | null = null;

  async get() {
    if (this.failure === "get") throw new Error("injected locked keyring");
    return this.raw;
  }
  async set(_apiUrl: string, raw: string) {
    if (this.failure === "set") throw new Error("injected denied keyring");
    this.raw = raw;
  }
  async delete() {
    if (this.failure === "delete") throw new Error("injected failed keyring deletion");
    this.raw = null;
  }
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myskills-keyring-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fallback = createFileTokenStore({ MYSKILLS_TOKEN_FILE: path.join(dir, "tokens.json") });
  const backend = new FakeKeyring();
  return { fallback, backend, store: createKeyringTokenStore(fallback, backend) };
}
