/**
 * Authored before source-auth implementation. This boundary complements the DB/HTTP
 * journey: only the provider transport can prove credentials never reach raw hosts
 * or redirects. A forwarded token, ignored identity, or bypassed cooldown must fail.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PublicGithubSourceProvider, gitBlobSha, type SourceHttpRequest } from "../src/libraries/github-source.js";

const repository = { id: "42", fullName: "example/skills", owner: "example", name: "skills", htmlUrl: "https://github.com/example/skills", defaultBranch: "main", private: false, archived: false, licenseSpdx: "MIT" };
const body = Buffer.from(JSON.stringify({ id: 42, full_name: "example/skills", default_branch: "main", private: false, license: { spdx_id: "MIT" } }));
const context = (userId: string) => ({ userId, deadline: Date.now() + 60_000 });

test("source credentials follow the owner; raw bytes and redirects never receive them", async () => {
  const requests: SourceHttpRequest[] = [];
  let redirect = false;
  const bytes = Buffer.from("public skill bytes");
  const provider = new PublicGithubSourceProvider({
    credentials: {
      credentialKey: async (id) => `user:${id}`,
      resolve: async (id) => ({ key: `user:${id}`, kind: "user", token: `fixture-${id}` }),
    },
    transport: { async get(request) {
      requests.push(request);
      return { status: redirect ? 302 : 200, headers: {}, body: request.url.host === "raw.githubusercontent.com" ? bytes : body };
    } },
  });
  await provider.getRepositoryById("42", context("alice"));
  await provider.getRepositoryById("42", context("bob"));
  assert.equal(requests[0].headers.authorization, "Bearer fixture-alice");
  assert.equal(requests[1].headers.authorization, "Bearer fixture-bob");
  await provider.readBlob(repository, "a".repeat(40), "SKILL.md", gitBlobSha(bytes), 100, context("alice"));
  assert.equal(requests[2].url.host, "raw.githubusercontent.com");
  assert.equal(requests[2].headers.authorization, undefined);
  redirect = true;
  await assert.rejects(provider.getRepositoryById("42", context("alice")), { code: "SOURCE_REDIRECT_REJECTED" });
  assert.equal(requests.length, 4, "redirect is not followed");
});

test("cooldown spans provider instances in the same credential bucket but not another user's quota", async () => {
  let now = Date.now();
  const reset = Math.floor(now / 1000) + 90;
  const records = new Map<string, Date>();
  let calls = 0;
  let limited = true;
  const options = {
    now: () => new Date(now),
    credentials: {
      credentialKey: async (id?: string) => `user:${id}`,
      resolve: async (id?: string) => ({ key: `user:${id}`, kind: "user" as const, token: `fixture-${id}` }),
    },
    cooldowns: {
      get: async (key: string) => records.get(key) ?? null,
      extend: async (key: string, until: Date) => { records.set(key, until); },
    },
    transport: { async get() {
      calls++;
      if (limited) return { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, body: Buffer.from("rate limited") };
      return { status: 200, headers: {}, body };
    } },
  };
  await assert.rejects(new PublicGithubSourceProvider(options).getRepositoryById("42", context("alice")), { code: "SOURCE_RATE_LIMITED" });
  limited = false;
  const restarted = new PublicGithubSourceProvider(options);
  await assert.rejects(restarted.getRepositoryById("42", context("alice")), { code: "SOURCE_RATE_LIMITED" });
  assert.equal(calls, 1);
  assert.equal((await restarted.retryAvailableAt("alice"))?.getTime(), reset * 1000);
  await restarted.getRepositoryById("42", context("bob"));
  assert.equal(calls, 2);
  now = reset * 1000 + 1;
  await restarted.getRepositoryById("42", context("alice"));
  assert.equal(calls, 3);
  assert.equal(await restarted.retryAvailableAt("alice"), null);
});

test("revoked credentials are marked invalid without an anonymous retry; private repositories stay blocked", async () => {
  let calls = 0;
  let invalid = 0;
  let status = 401;
  const provider = new PublicGithubSourceProvider({
    credentials: {
      credentialKey: async () => "user:42",
      resolve: async () => ({ key: "user:42", kind: "user", token: "fixture-revoked" }),
      markInvalid: async () => { invalid++; },
    },
    transport: { async get() {
      calls++;
      return { status, headers: {}, body: Buffer.from(JSON.stringify({ id: 42, full_name: "example/skills", default_branch: "main", private: true })) };
    } },
  });
  await assert.rejects(provider.getRepositoryById("42", context("alice")), { code: "SOURCE_AUTH_REQUIRED" });
  assert.equal(calls, 1);
  assert.equal(invalid, 1);
  status = 200;
  await assert.rejects(provider.getRepositoryById("42", context("alice")), { code: "SOURCE_ACCESS_LOST" });
});
