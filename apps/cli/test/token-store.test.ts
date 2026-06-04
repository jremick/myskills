import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileTokenStore } from "../src/token-store.js";

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
