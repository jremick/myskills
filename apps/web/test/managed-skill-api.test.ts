import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryClient, type SafeApiError, type SkillManagementSummary } from "../src/api.js";

const archived: SkillManagementSummary = {
  slug: "archived-helper",
  title: "Archived helper",
  summary: "Kept for managers after archive.",
  lifecycleStatus: "archived",
  visibility: "private",
  tags: ["workflow"],
  allowedActions: ["edit", "archive", "restore", "delete"],
};

test("managed skill detail uses the session-only route with an encoded slug and unwraps the summary", async () => {
  const calls: Array<{ url: string; method?: string; credentials?: RequestCredentials; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test/", async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      credentials: init?.credentials,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    return jsonResponse(200, { skill: archived });
  }, "session-token");

  assert.deepEqual(await client.getManagedSkill!("archived-helper"), archived);
  await client.getManagedSkill!("../admin?x=1#y");

  assert.deepEqual(calls.map((call) => call.url), [
    "http://api.test/v1/manage/skills/archived-helper",
    "http://api.test/v1/manage/skills/..%2Fadmin%3Fx%3D1%23y",
  ]);
  for (const call of calls) {
    assert.equal(call.method, undefined, "read-only GET");
    assert.equal(call.credentials, "include", "cookie sessions still travel");
    assert.equal(call.authorization, "Bearer session-token");
  }
});

test("managed skill detail keeps denial and missing-record status and code for the workspace", async () => {
  const responses = [
    jsonResponse(403, { error: { code: "SKILL_MANAGEMENT_ROLE_REQUIRED", message: "Skill management requires owner or maintainer permissions." } }),
    jsonResponse(404, { error: { code: "SKILL_NOT_FOUND", message: "Skill not found." } }),
    jsonResponse(403, { error: { code: "SESSION_AUTH_REQUIRED", message: "Session authentication is required." } }),
  ];
  const client = createRegistryClient("http://api.test", async () => responses.shift()!);

  for (const expected of [
    { status: 403, code: "SKILL_MANAGEMENT_ROLE_REQUIRED" },
    { status: 404, code: "SKILL_NOT_FOUND" },
    { status: 403, code: "SESSION_AUTH_REQUIRED" },
  ]) {
    await assert.rejects(client.getManagedSkill!("archived-helper"), (error: SafeApiError) => {
      assert.equal(error.status, expected.status);
      assert.equal(error.code, expected.code);
      return true;
    });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
