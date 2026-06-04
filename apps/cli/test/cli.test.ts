import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, type FetchLike } from "../src/cli.js";

test("validate reads a skill manifest from disk", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeManifest(dir);
  const output = createOutput();

  const code = await runCli(["validate", "--path", dir], testRuntime(output));

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["valid release-notes-helper@0.1.0"]);
});

test("scan exits nonzero when package has blocking findings", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeManifest(dir);
  const token = `ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;
  await writeFile(path.join(dir, "README.md"), `token: ${token}`);
  const output = createOutput();

  const code = await runCli(["scan", "--path", dir], testRuntime(output));

  assert.equal(code, 1);
  assert.match(output.stdout.join("\n"), /blocking\tsecret\tREADME\.md/);
});

test("search prints skill rows from the API", async () => {
  const output = createOutput();
  const fetch: FetchLike = async (input) => response(200, {
    skills: [{
      slug: "release-notes-helper",
      title: "Release Notes Helper",
      latestVersion: "0.1.0",
    }],
  }, String(input));

  const code = await runCli(["search", "release", "--api-url", "http://api.test"], testRuntime(output, fetch));

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["release-notes-helper\t0.1.0\tRelease Notes Helper"]);
});

test("search sends bearer token when available", async () => {
  const output = createOutput();
  let authorization = "";
  const fetch: FetchLike = async (_input, init) => {
    authorization = init?.headers?.authorization ?? "";
    return response(200, { skills: [] });
  };

  const code = await runCli(["search"], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "read-token" }));

  assert.equal(code, 0);
  assert.equal(authorization, "Bearer read-token");
});

test("info sends bearer token when available", async () => {
  const output = createOutput();
  let authorization = "";
  const fetch: FetchLike = async (_input, init) => {
    authorization = init?.headers?.authorization ?? "";
    return response(200, {
      skill: {
        slug: "release-notes-helper",
        title: "Release Notes Helper",
        summary: "Turns merged changes into concise release notes.",
        latestVersion: "0.1.0",
        platforms: [],
        tags: [],
      },
    });
  };

  const code = await runCli(["info", "release-notes-helper"], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "read-token" }));

  assert.equal(code, 0);
  assert.equal(authorization, "Bearer read-token");
});

test("whoami sends bearer token to the API", async () => {
  const output = createOutput();
  let authorization = "";
  const fetch: FetchLike = async (_input, init) => {
    authorization = init?.headers?.authorization ?? "";
    return response(200, {
      user: {
        email: "owner@example.com",
        roles: ["owner"],
        mfaVerified: false,
      },
    });
  };

  const code = await runCli(["whoami"], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "test-token" }));

  assert.equal(code, 0);
  assert.equal(authorization, "Bearer test-token");
  assert.deepEqual(output.stdout, ["owner@example.com\troles=owner\tmfa=not-verified"]);
});

test("submit requires a token before reading or posting", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeManifest(dir);
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["submit", "--path", dir], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /No token provided/);
});

test("submit blocks locally when scan has blocking findings", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeManifest(dir);
  await writeFile(path.join(dir, "README.md"), `token: ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`);
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["submit", "--path", dir], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, { AI_SKILLS_TOKEN: "submit-token" }));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stdout.join("\n"), /blocking\tsecret\tREADME\.md/);
});

test("submit sends package entries to the API", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeManifest(dir);
  await writeFile(path.join(dir, "README.md"), "Summarize release notes.");
  const output = createOutput();
  let method = "";
  let authorization = "";
  let body: { manifest?: { name?: string }; files?: Array<{ path: string; content: string }> } = {};
  const fetch: FetchLike = async (_input, init) => {
    method = init?.method ?? "GET";
    authorization = init?.headers?.authorization ?? "";
    body = JSON.parse(init?.body ?? "{}");
    return response(202, {
      submission: {
        id: "submission-1",
        slug: "release-notes-helper",
        version: "0.1.0",
        reviewStatus: "unreviewed",
        securityStatus: "passed",
      },
      scan: { findingCount: 0, findings: [] },
    });
  };

  const code = await runCli(["submit", "--path", dir], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "submit-token" }));

  assert.equal(code, 0);
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer submit-token");
  assert.equal(body.manifest?.name, "release-notes-helper");
  assert.deepEqual(body.files?.map((file) => file.path), ["README.md", "skill.json"]);
  assert.deepEqual(output.stdout, ["release-notes-helper@0.1.0\tunreviewed\tpassed\tfindings=0"]);
});

async function writeManifest(dir: string): Promise<void> {
  await writeFile(path.join(dir, "skill.json"), JSON.stringify({
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
  }));
}

async function makeTempPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ai-skills-cli-"));
}

function createOutput(): { stdout: string[]; stderr: string[] } {
  return { stdout: [], stderr: [] };
}

function testRuntime(
  output: { stdout: string[]; stderr: string[] },
  fetch: FetchLike = async () => response(500, {}),
  env: Record<string, string | undefined> = {},
) {
  return {
    env,
    fetch,
    io: {
      stdout: (line: string) => output.stdout.push(line),
      stderr: (line: string) => output.stderr.push(line),
    },
  };
}

function response(status: number, body: Record<string, unknown>, expectedInput?: string) {
  if (expectedInput && !expectedInput.startsWith("http://api.test/v1/skills?q=release")) {
    throw new Error(`Unexpected fetch URL: ${expectedInput}`);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}
