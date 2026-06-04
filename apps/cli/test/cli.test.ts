import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("review submissions requires a token before fetch", async () => {
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["review", "submissions"], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /No token provided/);
});

test("review submissions prints stable rows", async () => {
  const output = createOutput();
  let url = "";
  let authorization = "";
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    authorization = init?.headers?.authorization ?? "";
    return response(200, {
      submissions: [{
        id: "submission-1",
        slug: "release-notes-helper",
        version: "0.1.0",
        reviewStatus: "unreviewed",
        securityStatus: "passed",
        findingCount: 0,
      }],
    });
  };

  const code = await runCli(["review", "submissions", "--api-url", "http://api.test"], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "review-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/review/submissions");
  assert.equal(authorization, "Bearer review-token");
  assert.deepEqual(output.stdout, ["submission-1\trelease-notes-helper@0.1.0\tunreviewed\tpassed\tfindings=0"]);
});

test("review action posts exact action payload", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let authorization = "";
  let body: Record<string, unknown> = {};
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    authorization = init?.headers?.authorization ?? "";
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      submission: {
        slug: "release-notes-helper",
        version: "0.1.0",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: null,
      },
    });
  };

  const code = await runCli([
    "review",
    "action",
    "submission-1",
    "--action",
    "approve",
    "--reason",
    "checked",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "review-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/review/submissions/submission-1/actions");
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer review-token");
  assert.deepEqual(body, { action: "approve", reason: "checked" });
  assert.deepEqual(output.stdout, ["release-notes-helper@0.1.0\tapproved\tpassed\tpublished=-"]);
});

test("review action rejects unknown actions without fetch", async () => {
  const output = createOutput();
  let calls = 0;

  const code = await runCli([
    "review",
    "action",
    "submission-1",
    "--action",
    "delete",
  ], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, { AI_SKILLS_TOKEN: "review-token" }));

  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /--action must be approve or publish/);
});

test("export writes verified bundle files under output directory", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "ai-skills-export-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = createOutput();
  const bundle = JSON.stringify({
    files: [
      { path: "README.md", content: "Summarize release notes." },
      { path: "nested/skill.json", content: "{}" },
    ],
  });
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(String(input));
    if (String(input).endsWith("/bundle?platform=codex")) {
      return rawResponse(200, bundle);
    }
    return response(200, {
      release: {
        artifact: {
          sha256: createHash("sha256").update(bundle).digest("hex"),
          byteSize: Buffer.byteLength(bundle),
        },
      },
    });
  };

  const code = await runCli([
    "export",
    "release-notes-helper",
    "--version",
    "0.1.0",
    "--platform",
    "codex",
    "--output",
    outputDir,
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch));

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    "http://api.test/v1/skills/release-notes-helper/releases/0.1.0",
    "http://api.test/v1/skills/release-notes-helper/releases/0.1.0/bundle?platform=codex",
  ]);
  assert.equal(await readFile(path.join(outputDir, "README.md"), "utf8"), "Summarize release notes.");
  assert.equal(await readFile(path.join(outputDir, "nested", "skill.json"), "utf8"), "{}");
  assert.match(output.stdout[0], /release-notes-helper@0\.1\.0\texported\tfiles=2/);
});

test("export refuses unsafe bundle file paths before writing", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "ai-skills-export-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = createOutput();
  const bundle = JSON.stringify({
    files: [{ path: "../secret.txt", content: "nope" }],
  });
  const fetch: FetchLike = async (input) => {
    if (String(input).endsWith("/bundle?platform=codex")) {
      return rawResponse(200, bundle);
    }
    return response(200, {
      release: {
        artifact: {
          sha256: createHash("sha256").update(bundle).digest("hex"),
          byteSize: Buffer.byteLength(bundle),
        },
      },
    });
  };

  const code = await runCli([
    "export",
    "release-notes-helper",
    "--version",
    "0.1.0",
    "--platform",
    "codex",
    "--output",
    outputDir,
  ], testRuntime(output, fetch));

  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /cannot traverse directories/);
});

test("token create requires an existing bearer token before fetch", async () => {
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["token", "create", "--name", "Local CLI", "--scope", "profile:read"], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /No token provided/);
});

test("token create posts requested scopes and prints plaintext once", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let authorization = "";
  let body: Record<string, unknown> = {};
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    authorization = init?.headers?.authorization ?? "";
    body = JSON.parse(init?.body ?? "{}");
    return response(201, {
      token: {
        id: "api-token-1",
        name: "Local CLI",
        token: "aiss_plain-secret",
        tokenPrefix: "aiss_plain-s",
        scopes: ["profile:read", "skills:submit"],
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
    });
  };

  const code = await runCli([
    "token",
    "create",
    "--name",
    "Local CLI",
    "--scope",
    "profile:read",
    "--scope",
    "skills:submit",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "session-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/auth/api-tokens");
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer session-token");
  assert.deepEqual(body, { name: "Local CLI", scopes: ["profile:read", "skills:submit"] });
  assert.deepEqual(output.stdout, [
    "Local CLI\taiss_plain-s\tprofile:read,skills:submit\texpires=2026-12-01T00:00:00.000Z",
    "token: aiss_plain-secret",
  ]);
});

test("token list prints metadata without plaintext or hashes", async () => {
  const output = createOutput();
  let authorization = "";
  const fetch: FetchLike = async (_input, init) => {
    authorization = init?.headers?.authorization ?? "";
    return response(200, {
      tokens: [{
        id: "api-token-1",
        name: "Local CLI",
        tokenPrefix: "aiss_prefix",
        scopes: ["profile:read"],
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
        token: "should-not-print",
        tokenHash: "hash-should-not-print",
      }],
    });
  };

  const code = await runCli(["token", "list"], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "session-token" }));

  assert.equal(code, 0);
  assert.equal(authorization, "Bearer session-token");
  assert.equal(output.stdout.join("\n").includes("should-not-print"), false);
  assert.equal(output.stdout.join("\n").includes("hash-should-not-print"), false);
  assert.deepEqual(output.stdout, ["api-token-1\tLocal CLI\taiss_prefix\tprofile:read\texpires=2026-12-01T00:00:00.000Z\trevoked=-"]);
});

test("token revoke sends DELETE to the API", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let authorization = "";
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    authorization = init?.headers?.authorization ?? "";
    return response(200, {
      token: {
        id: "api-token-1",
        name: "Local CLI",
        revokedAt: "2026-06-04T00:00:00.000Z",
      },
    });
  };

  const code = await runCli(["token", "revoke", "api-token-1", "--api-url", "http://api.test", "--token", "explicit-token"], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "env-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/auth/api-tokens/api-token-1");
  assert.equal(method, "DELETE");
  assert.equal(authorization, "Bearer explicit-token");
  assert.deepEqual(output.stdout, ["api-token-1\tLocal CLI\trevoked=2026-06-04T00:00:00.000Z"]);
});

test("token create usage errors exit without fetch", async () => {
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["token", "create", "--name", "Local CLI"], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, { AI_SKILLS_TOKEN: "session-token" }));

  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /--scope is required/);
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

function rawResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}
