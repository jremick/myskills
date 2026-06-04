import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryClient, exportCommand, safeErrorMessage, type SafeApiError } from "../src/api.js";

test("registry client searches skills through the API", async () => {
  const calls: string[] = [];
  const client = createRegistryClient("http://api.test", async (input) => {
    calls.push(String(input));
    return jsonResponse(200, {
      skills: [{ slug: "release-notes-helper", title: "Release Notes Helper" }],
    });
  });

  const skills = await client.searchSkills("release notes");

  assert.equal(calls[0], "http://api.test/v1/skills?q=release%20notes");
  assert.equal(skills[0]?.slug, "release-notes-helper");
});

test("registry client fetches skill and release metadata without bundle content", async () => {
  const calls: string[] = [];
  const client = createRegistryClient("http://api.test", async (input) => {
    calls.push(String(input));
    if (String(input).includes("/releases/")) {
      return jsonResponse(200, { release: { version: "0.1.0", artifact: { sha256: "abc", byteSize: 12 } } });
    }
    return jsonResponse(200, { skill: { slug: "release-notes-helper", latestVersion: "0.1.0" } });
  });

  await client.getSkill("release-notes-helper");
  await client.getRelease("release-notes-helper", "0.1.0");

  assert.deepEqual(calls, [
    "http://api.test/v1/skills/release-notes-helper",
    "http://api.test/v1/skills/release-notes-helper/releases/0.1.0",
  ]);
  assert.equal(calls.some((call) => call.includes("/bundle")), false);
});

test("safe error messages do not render raw server internals", () => {
  const error = new Error("stack trace /Users/example token storageKey") as SafeApiError;
  error.status = 500;
  error.code = "INTERNAL_SERVER_ERROR";

  assert.equal(safeErrorMessage(error), "The registry is not available.");
});

test("export command matches CLI contract", () => {
  assert.equal(
    exportCommand("release-notes-helper", "0.1.0", "codex"),
    "ai-skills export release-notes-helper --version 0.1.0 --platform codex --output ./skills/release-notes-helper",
  );
});

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as Response;
}
