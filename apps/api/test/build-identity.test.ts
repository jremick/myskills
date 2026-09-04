import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { API_VERSION } from "../src/version.js";

test("build and registry identity are explicit and not cached", async (t) => {
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    registryInstanceId: "30c8d979-a7e2-4076-af70-9e2db2b8243f",
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/version.json" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().version, API_VERSION);
  assert.ok(response.json().revision === null || /^[a-f0-9]{40}$/.test(response.json().revision));
  const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
  assert.equal(capabilities.json().instanceId, "30c8d979-a7e2-4076-af70-9e2db2b8243f");
});
