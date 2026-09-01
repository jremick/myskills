import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, type FetchLike } from "../src/cli.js";
import { writeStoredZip } from "../../../test-support/zip-fixture.js";
import { assertValidArchitectureTargetObservation } from "@myskills-app/core";

test("validate reads a skill manifest from disk", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeManifest(dir);
  const output = createOutput();

  const code = await runCli(["validate", "--path", dir], testRuntime(output));

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["valid release-notes-helper@0.1.0"]);
});

test("validate reads a skill manifest from a zip", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "package.zip");
  await writeStoredZip(zipPath, [{ path: "skill.json", content: manifestJson() }]);
  const output = createOutput();

  const code = await runCli(["validate", "--path", zipPath], testRuntime(output));

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

test("scan exits nonzero when a zip package has blocking findings", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "unsafe.zip");
  const token = `ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "docs/README.md", content: `token: ${token}` },
  ]);
  const output = createOutput();

  const code = await runCli(["scan", "--path", zipPath], testRuntime(output));

  assert.equal(code, 1);
  assert.match(output.stdout.join("\n"), /blocking\tsecret\tdocs\/README\.md/);
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

  const code = await runCli(["search"], testRuntime(output, fetch, { MYSKILLS_TOKEN: "read-token" }));

  assert.equal(code, 0);
  assert.equal(authorization, "Bearer read-token");
});

test("API HTML responses explain that the CLI is pointed at the web app", async () => {
  const output = createOutput();
  const fetch: FetchLike = async () => rawResponse(200, "<html><body>web app</body></html>");

  const code = await runCli(["search", "--api-url", "https://myskills.sh"], testRuntime(output, fetch));

  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /returned HTML instead of JSON/);
  assert.match(output.stderr.join("\n"), /pointing the CLI at the web app/);
  assert.match(output.stderr.join("\n"), /Current API URL: https:\/\/myskills\.sh/);
});

test("unsupported newer API endpoints produce structured JSON errors", async () => {
  const output = createOutput();
  const fetch: FetchLike = async () => response(404, {
    message: "Route GET:/v1/teams not found",
    error: "Not Found",
    statusCode: 404,
  });

  const code = await runCli([
    "teams",
    "list",
    "--api-url",
    "http://api.test",
    "--json",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "team-token" }));

  assert.equal(code, 1);
  const parsed = JSON.parse(output.stderr.join("\n"));
  assert.equal(parsed.error.code, "API_UNSUPPORTED_ENDPOINT");
  assert.equal(parsed.error.status, 404);
  assert.match(parsed.error.message, /does not support the `teams` command yet/);
  assert.match(parsed.error.message, /myskills doctor/);
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

  const code = await runCli(["info", "release-notes-helper"], testRuntime(output, fetch, { MYSKILLS_TOKEN: "read-token" }));

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

  const code = await runCli(["whoami"], testRuntime(output, fetch, { MYSKILLS_TOKEN: "test-token" }));

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
  }, { MYSKILLS_TOKEN: "submit-token" }));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stdout.join("\n"), /blocking\tsecret\tREADME\.md/);
});

test("submit blocks locally when a zip package has blocking findings", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "unsafe.zip");
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "README.md", content: `token: ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}` },
  ]);
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["submit", "--path", zipPath], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, { MYSKILLS_TOKEN: "submit-token" }));

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

  const code = await runCli(["submit", "--path", dir], testRuntime(output, fetch, { MYSKILLS_TOKEN: "submit-token" }));

  assert.equal(code, 0);
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer submit-token");
  assert.equal(body.manifest?.name, "release-notes-helper");
  assert.deepEqual(body.files?.map((file) => file.path), ["README.md", "skill.json"]);
  assertPackageManifestMatchesBody(body);
  assert.deepEqual(output.stdout, ["release-notes-helper@0.1.0\tunreviewed\tpassed\tfindings=0"]);
});

test("submit sends zip archives to the API without extracted file entries", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "package.zip");
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "README.md", content: "Summarize release notes." },
  ]);
  const output = createOutput();
  let method = "";
  let authorization = "";
  let body: {
    manifest?: { name?: string; version?: string; title?: string };
    archive?: { filename?: string; contentBase64?: string };
    files?: Array<{ path: string; content: string }>;
  } = {};
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

  const code = await runCli(["submit", "--path", zipPath], testRuntime(output, fetch, { MYSKILLS_TOKEN: "submit-token" }));

  assert.equal(code, 0);
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer submit-token");
  assert.equal(body.manifest?.name, "release-notes-helper");
  assert.equal(body.archive?.filename, "package.zip");
  assert.equal(body.archive?.contentBase64, (await readFile(zipPath)).toString("base64"));
  assert.equal(body.files, undefined);
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

  const code = await runCli(["review", "submissions", "--api-url", "http://api.test"], testRuntime(output, fetch, { MYSKILLS_TOKEN: "review-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/review/submissions");
  assert.equal(authorization, "Bearer review-token");
  assert.deepEqual(output.stdout, ["submission-1\trelease-notes-helper@0.1.0\tunreviewed\tpassed\tfindings=0"]);
});

test("review bundle prints the artifact hash and can write the payload", async () => {
  const output = createOutput();
  const tempDir = await makeTempPackage();
  const outputPath = path.join(tempDir, "review-bundle.json");
  const payloadText = JSON.stringify({ files: [{ path: "skill.json", content: "{}" }] });
  const artifactSha256 = createHash("sha256").update(payloadText).digest("hex");
  let url = "";
  let authorization = "";
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    authorization = init?.headers?.authorization ?? "";
    return rawResponse(200, payloadText, {
      "x-myskills-artifact-sha256": artifactSha256,
    });
  };

  const code = await runCli([
    "review",
    "bundle",
    "submission-1",
    "--platform",
    "codex",
    "--output",
    outputPath,
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "review-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/review/submissions/submission-1/bundle?platform=codex");
  assert.equal(authorization, "Bearer review-token");
  assert.deepEqual(output.stdout, [`artifactSha256=${artifactSha256}\toutput=${path.resolve(outputPath)}`]);
  const writtenText = await readFile(outputPath, "utf8");
  assert.equal(createHash("sha256").update(writtenText).digest("hex"), artifactSha256);
  assert.deepEqual(JSON.parse(writtenText), { files: [{ path: "skill.json", content: "{}" }] });
});

test("review bundle fails closed when the artifact hash header is missing", async () => {
  const output = createOutput();

  const code = await runCli([
    "review",
    "bundle",
    "submission-1",
  ], testRuntime(output, async () => rawResponse(200, JSON.stringify({ files: [] })), { MYSKILLS_TOKEN: "review-token" }));

  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /missing artifact hash/);
});

test("review action posts exact action payload", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let authorization = "";
  let body: Record<string, unknown> = {};
  const artifactSha256 = "a".repeat(64);
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
    "--artifact-sha256",
    artifactSha256,
    "--reason",
    "checked",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "review-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/review/submissions/submission-1/actions");
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer review-token");
  assert.deepEqual(body, { action: "approve", artifactSha256, reason: "checked" });
  assert.deepEqual(output.stdout, ["release-notes-helper@0.1.0\tapproved\tpassed\tpublished=-"]);
});

test("review approve requires a lowercase artifact hash before fetch", async () => {
  const cases = [
    ["missing", []],
    ["malformed", ["--artifact-sha256", "abc"]],
  ];
  for (const [label, args] of cases) {
    const output = createOutput();
    let calls = 0;

    const code = await runCli([
      "review",
      "action",
      "submission-1",
      "--action",
      "approve",
      ...(args as string[]),
    ], testRuntime(output, async () => {
      calls += 1;
      return response(500, {});
    }, { MYSKILLS_TOKEN: "review-token" }));

    assert.equal(code, 2, label);
    assert.equal(calls, 0, label);
    assert.match(output.stderr.join("\n"), /--artifact-sha256 is required/);
  }
});

test("review approve normalizes uppercase artifact hashes", async () => {
  const output = createOutput();
  let body: Record<string, unknown> = {};
  const fetch: FetchLike = async (_input, init) => {
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
    "--artifact-sha256",
    "A".repeat(64),
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "review-token" }));

  assert.equal(code, 0);
  assert.equal(body.artifactSha256, "a".repeat(64));
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
  }, { MYSKILLS_TOKEN: "review-token" }));

  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /--action must be approve, request-changes, reject, or publish/);
});

test("submission withdraw posts owner action", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let body: Record<string, unknown> = {};
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      submission: {
        id: "submission-1",
        slug: "release-notes-helper",
        version: "0.1.0",
        reviewStatus: "rejected",
        lifecycleStatus: "archived",
      },
    });
  };

  const code = await runCli([
    "submissions",
    "withdraw",
    "submission-1",
    "--reason",
    "wrong version",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "author-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/submissions/submission-1/actions");
  assert.equal(method, "POST");
  assert.deepEqual(body, { action: "withdraw", reason: "wrong version" });
  assert.deepEqual(output.stdout, ["submission-1\trelease-notes-helper\t0.1.0\trejected\tarchived"]);
});

test("release lifecycle command posts release action", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let body: Record<string, unknown> = {};
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      release: {
        slug: "release-notes-helper",
        version: "0.1.0",
        lifecycleStatus: "unpublished",
        reviewStatus: "approved",
        securityStatus: "passed",
      },
    });
  };

  const code = await runCli([
    "releases",
    "unpublish",
    "release-notes-helper@0.1.0",
    "--reason",
    "bad docs",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "maintainer-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/skills/release-notes-helper/releases/0.1.0/actions");
  assert.equal(method, "POST");
  assert.deepEqual(body, { action: "unpublish", reason: "bad docs" });
  assert.deepEqual(output.stdout, ["release-notes-helper\t0.1.0\tunpublished\tapproved\tpassed"]);
});

test("skills edit sends only requested metadata", async () => {
  const output = createOutput();
  let url = "";
  let method = "";
  let body: Record<string, unknown> = {};
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      skill: {
        slug: "release-notes-helper",
        title: "Release Notes Assistant",
        lifecycleStatus: "approved",
        visibility: "public",
      },
    });
  };

  const code = await runCli([
    "skills",
    "edit",
    "release-notes-helper",
    "--title",
    "Release Notes Assistant",
    "--tag",
    "writing",
    "--tag",
    "release",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "maintainer-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/skills/release-notes-helper");
  assert.equal(method, "PUT");
  assert.deepEqual(body, { title: "Release Notes Assistant", tags: ["writing", "release"] });
  assert.deepEqual(output.stdout, ["release-notes-helper\tRelease Notes Assistant\tapproved\tpublic"]);
});

test("teams commands create, invite, and accept through the API", async () => {
  const output = createOutput();
  const calls: Array<{ url: string; method: string; authorization: string; body: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: init?.headers?.authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    });
    const url = String(input);
    if (url.endsWith("/v1/teams")) {
      return response(201, {
        team: {
          id: "team-1",
          name: "Platform",
          role: "owner",
          members: [],
          invitations: [],
        },
      });
    }
    if (url.endsWith("/v1/teams/team-1/invitations")) {
      return response(201, {
        invitation: {
          id: "invitation-1",
          teamId: "team-1",
          teamName: "Platform",
          email: "user@example.com",
          status: "pending",
        },
      });
    }
    return response(200, {
      invitation: {
        id: "invitation-1",
        teamId: "team-1",
        teamName: "Platform",
        email: "user@example.com",
        status: "accepted",
      },
    });
  };
  const runtime = testRuntime(output, fetch, { MYSKILLS_TOKEN: "team-token" });

  const create = await runCli(["teams", "create", "Platform", "--api-url", "http://api.test"], runtime);
  const invite = await runCli(["teams", "invite", "team-1", "--email", "user@example.com", "--api-url", "http://api.test"], runtime);
  const accept = await runCli(["teams", "accept", "invitation-1", "--api-url", "http://api.test"], runtime);

  assert.equal(create, 0);
  assert.equal(invite, 0);
  assert.equal(accept, 0);
  assert.deepEqual(calls, [
    {
      url: "http://api.test/v1/teams",
      method: "POST",
      authorization: "Bearer team-token",
      body: { name: "Platform" },
    },
    {
      url: "http://api.test/v1/teams/team-1/invitations",
      method: "POST",
      authorization: "Bearer team-token",
      body: { email: "user@example.com" },
    },
    {
      url: "http://api.test/v1/teams/invitations/invitation-1/accept",
      method: "POST",
      authorization: "Bearer team-token",
      body: {},
    },
  ]);
  assert.deepEqual(output.stdout, [
    "team-1\tPlatform\tcreated\trole=owner",
    "invitation-1\tuser@example.com\tinvited\tteam=Platform\tstatus=pending",
    "invitation-1\tPlatform\taccepted\tstatus=accepted",
  ]);
});

test("teams list and skills print stable team sharing rows", async () => {
  const output = createOutput();
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push(`${init?.headers?.authorization ?? ""} ${String(input)}`);
    if (String(input).endsWith("/v1/teams/shared-skills")) {
      return response(200, {
        teams: [{
          team: { id: "team-1", name: "Platform", role: "owner" },
          sharingWithTeam: [{
            slug: "release-notes-helper",
            title: "Release Notes Helper",
            latestVersion: "0.1.0",
          }],
          sharedWithMe: [{
            slug: "incident-summary",
            title: "Incident Summary",
            latestVersion: null,
          }],
        }],
      });
    }
    return response(200, {
      teams: [{
        id: "team-1",
        name: "Platform",
        role: "owner",
        members: [{ id: "user-1" }],
        invitations: [{
          id: "invitation-1",
          teamId: "team-1",
          teamName: "Platform",
          email: "pending@example.com",
          status: "pending",
        }],
      }],
      invitations: [{
        id: "invitation-2",
        teamId: "team-2",
        teamName: "Data",
        email: "owner@example.com",
        status: "pending",
      }],
    });
  };
  const runtime = testRuntime(output, fetch, { MYSKILLS_TOKEN: "team-token" });

  const list = await runCli(["teams", "list", "--api-url", "http://api.test"], runtime);
  const skills = await runCli(["teams", "skills", "--api-url", "http://api.test"], runtime);

  assert.equal(list, 0);
  assert.equal(skills, 0);
  assert.deepEqual(calls, [
    "Bearer team-token http://api.test/v1/teams",
    "Bearer team-token http://api.test/v1/teams/shared-skills",
  ]);
  assert.deepEqual(output.stdout, [
    "team\tteam-1\tPlatform\trole=owner\tmembers=1\tpending=1",
    "invitation\tinvitation-2\tData\towner@example.com\tstatus=pending",
    "team\tteam-1\tPlatform\trole=owner\tsharing-out=1\tshared-in=1",
    "sharing-out\tteam-1\trelease-notes-helper\t0.1.0\tRelease Notes Helper",
    "shared-in\tteam-1\tincident-summary\t-\tIncident Summary",
  ]);
});

test("sharing set omits organizationIds for beta.2 compatibility when no organization IDs are supplied", async () => {
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
      sharing: {
        slug: "release-notes-helper",
        title: "Release Notes Helper",
        visibility: "team",
        settings: sharingSettingsBody(),
        availableTeams: [],
        teamGrants: [{ id: "team-1", name: "Platform", role: "owner" }],
        userGrants: [{ id: "user-1", email: "user@example.com", name: "User" }],
      },
    });
  };

  const code = await runCli([
    "sharing",
    "set",
    "release-notes-helper",
    "--visibility",
    "team",
    "--team",
    "team-1",
    "--team",
    "team-2",
    "--user",
    "user@example.com",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "sharing-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/skills/release-notes-helper/sharing");
  assert.equal(method, "PUT");
  assert.equal(authorization, "Bearer sharing-token");
  assert.deepEqual(body, {
    visibility: "team",
    teamIds: ["team-1", "team-2"],
    userEmails: ["user@example.com"],
  });
  assert.deepEqual(output.stdout, ["release-notes-helper\tvisibility=team\tteams=Platform(team-1)\tusers=user@example.com"]);
});

test("sharing set forwards explicit organization grants without changing the API-owned visibility gate", async () => {
  const output = createOutput();
  let body: Record<string, unknown> = {};
  const code = await runCli([
    "sharing",
    "set",
    "release-notes-helper",
    "--visibility",
    "organization",
    "--organization",
    "org-one",
    "--organization-id",
    "org-two",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, async (_input, init) => {
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      sharing: {
        slug: "release-notes-helper",
        title: "Release Notes Helper",
        visibility: "organization",
        settings: sharingSettingsBody(),
        availableTeams: [],
        teamGrants: [],
        userGrants: [],
        availableOrganizations: [
          { id: "org-one", name: "One", slug: "one", status: "active", role: "owner" },
          { id: "org-two", name: "Two", slug: "two", status: "active", role: "member" },
        ],
        organizationGrants: [
          { id: "org-one", name: "One", slug: "one", status: "active", role: "owner" },
          { id: "org-two", name: "Two", slug: "two", status: "active", role: "member" },
        ],
      },
    });
  }, { MYSKILLS_TOKEN: "sharing-token" }));

  assert.equal(code, 0);
  assert.deepEqual(body, {
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: ["org-one", "org-two"],
  });
  assert.deepEqual(output.stdout, ["release-notes-helper\tvisibility=organization\tteams=-\tusers=-\torganizations=One(org-one),Two(org-two)"]);
});

test("sharing set sends an explicit empty organization grant set when requested", async () => {
  const output = createOutput();
  let body: Record<string, unknown> = {};
  const code = await runCli([
    "sharing",
    "set",
    "release-notes-helper",
    "--visibility",
    "organization",
    "--clear-organizations",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, async (_input, init) => {
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      sharing: {
        slug: "release-notes-helper",
        title: "Release Notes Helper",
        visibility: "organization",
        settings: sharingSettingsBody(),
        availableTeams: [],
        teamGrants: [],
        userGrants: [],
        availableOrganizations: [],
        organizationGrants: [],
      },
    });
  }, { MYSKILLS_TOKEN: "sharing-token" }));

  assert.equal(code, 0);
  assert.deepEqual(body, {
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [],
  });
  assert.deepEqual(output.stdout, ["release-notes-helper\tvisibility=organization\tteams=-\tusers=-"]);
});

test("sharing set rejects clear-organizations together with organization IDs before fetch", async () => {
  const output = createOutput();
  let calls = 0;
  const code = await runCli([
    "sharing",
    "set",
    "release-notes-helper",
    "--visibility",
    "organization",
    "--organization-id",
    "org-one",
    "--clear-organizations",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, { MYSKILLS_TOKEN: "sharing-token" }));

  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /--clear-organizations cannot be combined/);
});

test("help documents canonical organization grant clearing and architecture organization context", async () => {
  const output = createOutput();
  const code = await runCli(["help"], testRuntime(output));

  assert.equal(code, 0);
  assert.match(output.stdout[0] ?? "", /sharing set .*--organization-id <organization-id>.*--clear-organizations/);
  assert.match(output.stdout[0] ?? "", /architectures preview\|compile .*--organization-id <organization-id>/);
  assert.match(output.stdout[0] ?? "", /architectures plan\|dry-run .*--organization-id <organization-id>/);
});

test("sharing get requires a token before fetch", async () => {
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["sharing", "get", "release-notes-helper"], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /No token provided/);
});

test("admin sharing set merges supplied toggles with current settings", async () => {
  const output = createOutput();
  const calls: Array<{ url: string; method: string; authorization: string; body: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: init?.headers?.authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    });
    if ((init?.method ?? "GET") === "GET") {
      return response(200, { sharing: sharingSettingsBody() });
    }
    return response(200, { sharing: JSON.parse(init?.body ?? "{}") });
  };

  const code = await runCli([
    "admin",
    "sharing",
    "set",
    "--public",
    "false",
    "--teams",
    "true",
    "--user-visibility",
    "false",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "owner-token" }));

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    {
      url: "http://api.test/v1/admin/sharing",
      method: "GET",
      authorization: "Bearer owner-token",
      body: {},
    },
    {
      url: "http://api.test/v1/admin/sharing",
      method: "PUT",
      authorization: "Bearer owner-token",
      body: {
        publicVisibilityEnabled: false,
        authenticatedVisibilityEnabled: true,
        teamsEnabled: true,
        teamVisibilityEnabled: true,
        userVisibilityEnabled: false,
        organizationVisibilityEnabled: true,
      },
    },
  ]);
  assert.deepEqual(output.stdout, [
    "public=disabled\tauthenticated=enabled\tteams=enabled\tteam-visibility=enabled\tuser-visibility=disabled\torganization-visibility=enabled",
  ]);
});

test("admin sharing set preserves an omitted organization switch from a legacy response", async () => {
  const output = createOutput();
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const code = await runCli([
    "admin",
    "sharing",
    "set",
    "--public",
    "false",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, async (_input, init) => {
    const method = init?.method ?? "GET";
    const requestBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ method, body: requestBody });
    return response(200, method === "PUT"
      ? { sharing: { ...requestBody, organizationVisibilityEnabled: true } }
      : { sharing: {
        publicVisibilityEnabled: true,
        authenticatedVisibilityEnabled: true,
        teamsEnabled: true,
        teamVisibilityEnabled: true,
        userVisibilityEnabled: true,
      } });
  }, { MYSKILLS_TOKEN: "owner-token" }));

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    { method: "GET", body: {} },
    {
      method: "PUT",
      body: {
        publicVisibilityEnabled: false,
        authenticatedVisibilityEnabled: true,
        teamsEnabled: true,
        teamVisibilityEnabled: true,
        userVisibilityEnabled: true,
      },
    },
  ]);
  assert.match(output.stdout[0] ?? "", /organization-visibility=enabled/);
});

test("architecture patterns are read through the API with a bearer token", async () => {
  const output = createOutput();
  let url = "";
  let authorization = "";
  const code = await runCli([
    "architectures",
    "patterns",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, async (input, init) => {
    url = String(input);
    authorization = init?.headers?.authorization ?? "";
    return response(200, {
      patterns: [{
        id: "multi-level-router",
        name: "Multi-level routers",
        description: "Nested routers and skill leaves.",
        status: "available",
      }],
    });
  }, { MYSKILLS_TOKEN: "architecture-token" }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/architecture-patterns");
  assert.equal(authorization, "Bearer architecture-token");
  assert.deepEqual(output.stdout, [
    "multi-level-router\tMulti-level routers\tNested routers and skill leaves.\tavailable",
  ]);
});

test("architecture list, show, and preview use read-only API surfaces", async () => {
  const output = createOutput();
  const calls: Array<{ url: string; method: string; authorization: string; body: Record<string, unknown> }> = [];
  const codeList = await runCli([
    "architectures",
    "list",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: init?.headers?.authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    });
    return response(200, {
      architectures: [{
        id: "arch-1",
        name: "Personal skills",
        patternId: "multi-level-router",
        currentRevisionId: "revision-2",
        updatedAt: "2026-08-30T00:00:00.000Z",
      }],
    });
  }));
  const codeShow = await runCli([
    "architectures",
    "show",
    "arch-1",
    "--revision",
    "revision-2",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: init?.headers?.authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    });
    return response(200, {
      revision: { id: "revision-2", message: "Add nested router", createdAt: "2026-08-30T00:00:00.000Z" },
    });
  }));
  const codePreview = await runCli([
    "architectures",
    "compile",
    "arch-1",
    "--revision",
    "revision-2",
    "--profile",
    "personal",
    "--environment",
    "local",
    "--organization-id",
    "org-1",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: init?.headers?.authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    });
    return response(200, {
      revision: { id: "revision-2" },
      compiled: { architectureId: "arch-1", nodes: [{ id: "root", kind: "router", label: "Root" }] },
      graph: {
        nodes: [{ id: "root", kind: "router", label: "Root" }],
        edges: [],
        mermaid: "flowchart TD\n  root[Root]",
      },
      outline: { tree: [{ id: "root", kind: "router", label: "Root", children: [] }] },
    });
  }));

  assert.equal(codeList, 0);
  assert.equal(codeShow, 0);
  assert.equal(codePreview, 0);
  assert.deepEqual(calls, [
    {
      url: "http://api.test/v1/architectures",
      method: "GET",
      authorization: "Bearer architecture-token",
      body: {},
    },
    {
      url: "http://api.test/v1/architectures/arch-1/revisions/revision-2",
      method: "GET",
      authorization: "Bearer architecture-token",
      body: {},
    },
    {
      url: "http://api.test/v1/architectures/arch-1/preview",
      method: "POST",
      authorization: "Bearer architecture-token",
      body: { profileId: "personal", environmentId: "local", organizationId: "org-1", revisionId: "revision-2" },
    },
  ]);
  assert.deepEqual(output.stdout, [
    "arch-1\tPersonal skills\tmulti-level-router\trevision-2\t2026-08-30T00:00:00.000Z",
    "revision\trevision-2\tAdd nested router\t2026-08-30T00:00:00.000Z",
    "preview\tarch-1\trevision-2\tnodes=1\tplan=not-generated",
    "flowchart TD\n  root[Root]",
  ]);
});

test("architecture preview accepts the beta organization flag alias and rejects conflicting aliases", async () => {
  const output = createOutput();
  let body: Record<string, unknown> = {};
  const code = await runCli([
    "architectures",
    "preview",
    "arch-1",
    "--organization",
    "org-1",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
    "--json",
  ], testRuntime(output, async (_input, init) => {
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      compiled: { architectureId: "arch-1", nodes: [], edges: [] },
      graph: { nodes: [], edges: [], mermaid: "flowchart TD" },
    });
  }));

  assert.equal(code, 0);
  assert.deepEqual(body, { organizationId: "org-1" });
  assert.deepEqual(JSON.parse(output.stdout[0] ?? "{}"), {
    architectureId: "arch-1",
    topology: { nodes: [], edges: [] },
    graph: { nodes: [], edges: [], mermaid: "flowchart TD" },
    compiled: { architectureId: "arch-1" },
  });

  const conflictOutput = createOutput();
  const conflictCode = await runCli([
    "architectures",
    "preview",
    "arch-1",
    "--organization",
    "org-1",
    "--organization-id",
    "org-2",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(conflictOutput, async () => response(500, {})));
  assert.equal(conflictCode, 2);
  assert.match(conflictOutput.stderr.join("\n"), /must match/);
});

test("architecture revision aliases reject conflicts and repeated flags before fetch", async () => {
  let calls = 0;
  const conflictOutput = createOutput();
  const conflictCode = await runCli([
    "architectures",
    "preview",
    "arch-1",
    "--revision",
    "revision-a",
    "--version",
    "revision-b",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(conflictOutput, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(conflictCode, 2);
  assert.match(conflictOutput.stderr.join("\n"), /revision.*version.*must match/);

  const repeatedOutput = createOutput();
  const repeatedCode = await runCli([
    "architectures",
    "show",
    "arch-1",
    "--revision-id",
    "revision-a",
    "--revision-id",
    "revision-a",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(repeatedOutput, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(repeatedCode, 2);
  assert.match(repeatedOutput.stderr.join("\n"), /--revision-id accepts one value/);
  assert.equal(calls, 0);
});

test("architecture preview human Mermaid output redacts URLs and local paths", async () => {
  const output = createOutput();
  const code = await runCli([
    "architectures",
    "preview",
    "arch-1",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async () => response(200, {
    architectureId: "arch-1",
    mermaid: "flowchart TD\n  root[Local C:\\Users\\jarel\\private\\node]\n  unc[\\\\server\\share\\node]\n  docs[See /architecture/overview]\n  remote[https://example.test/docs]",
  })));

  assert.equal(code, 0);
  assert.equal(output.stdout[0], "preview\tarch-1\t-\tnodes=0\tplan=not-generated");
  const rendered = output.stdout[1] ?? "";
  assert.match(rendered, /\[redacted path\]/);
  assert.match(rendered, /\[redacted URL\]/);
  assert.match(rendered, /\/architecture\/overview/);
  assert.equal(rendered.includes("jarel"), false);
  assert.equal(rendered.includes("example.test"), false);
  assert.equal(rendered.includes("server\\share"), false);
});

test("architecture JSON projections redact package, path, and credential fields", async () => {
  const output = createOutput();
  const code = await runCli([
    "architectures",
    "list",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
    "--json",
  ], testRuntime(output, async () => response(200, {
    architectures: [{
      id: "arch-1",
      name: "Personal skills",
      patternId: "flat",
      access: { allowedOrganizationIds: ["org-z", "org-a", "org-a"], ownerUserId: "user-secret" },
      spec: { path: "/private/spec.json", content: "secret package text" },
      credentials: { token: "aiss_test_secret" },
    }],
  })));

  assert.equal(code, 0);
  const projection = JSON.parse(output.stdout[0] ?? "{}");
  assert.deepEqual(projection.architectures, [{
    id: "arch-1",
    name: "Personal skills",
    patternId: "flat",
    allowedOrganizationIds: ["org-a", "org-z"],
  }]);
  const text = JSON.stringify(projection);
  assert.equal(text.includes("/private/spec.json"), false);
  assert.equal(text.includes("secret package text"), false);
  assert.equal(text.includes("aiss_test_secret"), false);
  assert.equal(text.includes("ownerUserId"), false);
});

test("architecture API errors redact sensitive upstream details", async () => {
  const output = createOutput();
  const code = await runCli([
    "architectures",
    "preview",
    "arch-1",
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async () => response(403, {
    error: {
      code: "ARCHITECTURE_DENIED",
      message: "scope missing for Bearer aiss_test_secret /private/path storageKey secret package text",
    },
  })));

  assert.equal(code, 1);
  const text = output.stderr.join("\n");
  assert.match(text, /architecture request could not be completed/i);
  assert.equal(text.includes("aiss_test_secret"), false);
  assert.equal(text.includes("/private/path"), false);
  assert.equal(text.includes("storageKey"), false);
  assert.equal(text.includes("secret package text"), false);
});

test("architecture commands reject API URLs with embedded credentials or query tokens", async () => {
  const output = createOutput();
  const code = await runCli([
    "architectures",
    "list",
    "--api-url",
    "https://user:secret@example.test/api?token=secret",
    "--token",
    "architecture-token",
  ], testRuntime(output, async () => response(500, {})));

  assert.equal(code, 2);
  assert.match(output.stderr.join("\n"), /valid http:\/\/ or https:\/\/ URL/);
  assert.equal(output.stderr.join("\n").includes("secret"), false);
});

test("architecture dry-run validates and sends a bounded observed-state fixture without writing", async (t) => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "myskills-observed-state-"));
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, "observed.json");
  const fixture = {
    schemaVersion: "myskills.observed-state.v1",
    environment: {
      environmentKey: "personal-local",
      toolKind: "codex",
      adapterVersion: "fixture-1",
      capabilities: { canInstall: true, canUpdate: true },
    },
    inventory: [{ kind: "skill", ref: "skill.release-notes", slug: "release-notes-helper", version: "0.1.0", source: "myskills" }],
  };
  await writeFile(fixturePath, JSON.stringify(fixture));
  const before = await readFile(fixturePath, "utf8");
  const output = createOutput();
  let request: { url: string; method: string; authorization: string; body: Record<string, unknown> } | null = null;
  const code = await runCli([
    "architectures",
    "plan",
    "arch-1",
    "--revision",
    "revision-2",
    "--profile",
    "personal",
    "--environment",
    "personal-local",
    "--organization-id",
    "org-1",
    "--observed",
    fixturePath,
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async (input, init) => {
    request = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: init?.headers?.authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    };
    return response(200, {
      plan: {
        dryRun: true,
        items: [{ action: "update", nodeId: "release-notes-helper", reason: "0.1.0 -> 0.2.0" }],
      },
    });
  }));

  assert.equal(code, 0);
  assert.deepEqual(request, {
    url: "http://api.test/v1/architectures/arch-1/preview",
    method: "POST",
    authorization: "Bearer architecture-token",
    body: {
      revisionId: "revision-2",
      profileId: "personal",
      environmentId: "personal-local",
      organizationId: "org-1",
      fixture: {
        targetId: "personal-local",
        environmentId: "personal-local",
        nodes: [{
          nodeId: "skill.release-notes",
          skillRefId: "skill.release-notes",
          kind: "leaf",
          slug: "release-notes-helper",
          version: "0.1.0",
        }],
      },
    },
  });
  assert.deepEqual(output.stdout, [
    "dry-run\tchanges\tchanges=1",
    "change\tupdate\trelease-notes-helper\t0.1.0 -> 0.2.0",
  ]);
  assert.equal(await readFile(fixturePath, "utf8"), before);
});

test("architecture dry-run rejects invalid or oversized fixtures before fetch", async (t) => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "myskills-observed-state-invalid-"));
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  const invalidPath = path.join(fixtureDir, "invalid.json");
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: "wrong", environment: {}, inventory: [] }));
  const oversizedPath = path.join(fixtureDir, "oversized.json");
  await writeFile(oversizedPath, JSON.stringify({
    schemaVersion: "myskills.observed-state.v1",
    environment: {},
    inventory: [],
    padding: "x".repeat(256 * 1024),
  }));
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls += 1;
    return response(500, {});
  };
  const invalidOutput = createOutput();
  const invalidCode = await runCli([
    "architectures",
    "plan",
    "arch-1",
    "--observed",
    invalidPath,
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(invalidOutput, fetch));
  const oversizedOutput = createOutput();
  const oversizedCode = await runCli([
    "architectures",
    "plan",
    "arch-1",
    "--observed",
    oversizedPath,
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(oversizedOutput, fetch));

  assert.equal(invalidCode, 2);
  assert.match(invalidOutput.stderr.join("\n"), /schemaVersion/);
  assert.equal(oversizedCode, 2);
  assert.match(oversizedOutput.stderr.join("\n"), /256 KiB/);
  assert.equal(calls, 0);
});

test("architecture dry-run rejects unsafe fixture identifiers, slugs, paths, and control characters before fetch", async (t) => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "myskills-observed-state-safety-"));
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  const baseFixture = {
    schemaVersion: "myskills.observed-state.v1",
    environment: {
      environmentKey: "personal-local",
      toolKind: "codex",
      adapterVersion: "fixture-1",
      capabilities: { canInstall: true },
    },
    inventory: [{ kind: "skill", ref: "skill.release-notes", slug: "release-notes-helper", source: "local" }],
  };
  const cases: Array<{ name: string; fixture: Record<string, unknown>; expected: RegExp }> = [
    {
      name: "identifier",
      fixture: {
        ...baseFixture,
        inventory: [{ ...baseFixture.inventory[0], ref: "../private" }],
      },
      expected: /inventory\.ref is invalid/,
    },
    {
      name: "slug",
      fixture: {
        ...baseFixture,
        inventory: [{ ...baseFixture.inventory[0], slug: "Release Notes" }],
      },
      expected: /inventory\.slug is invalid/,
    },
    {
      name: "path",
      fixture: {
        ...baseFixture,
        inventory: [{ ...baseFixture.inventory[0], path: "/private/skill" }],
      },
      expected: /field is not accepted: path/,
    },
    {
      name: "control-character",
      fixture: {
        ...baseFixture,
        environment: { ...baseFixture.environment, adapterVersion: "fixture-\u001b[31m1" },
      },
      expected: /environment\.adapterVersion is invalid/,
    },
  ];
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls += 1;
    return response(500, {});
  };

  for (const item of cases) {
    const fixturePath = path.join(fixtureDir, `${item.name}.json`);
    await writeFile(fixturePath, JSON.stringify(item.fixture));
    const output = createOutput();
    const code = await runCli([
      "architectures",
      "plan",
      "arch-1",
      "--observed",
      fixturePath,
      "--api-url",
      "http://api.test",
      "--token",
      "architecture-token",
    ], testRuntime(output, fetch));

    assert.equal(code, 2, item.name);
    assert.match(output.stderr.join("\n"), item.expected, item.name);
  }
  assert.equal(calls, 0);
});

test("codex observe emits a core-valid metadata-only report from an explicit context without network or path leakage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-cli-personal-"));
  const contextRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-cli-context-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(contextRoot, { recursive: true, force: true }),
  ]));
  await writeCodexFixture(root, "personal", ["personal-only", "shared-tool"]);
  const contextPath = path.join(contextRoot, "target-context.json");
  await writeFile(contextPath, JSON.stringify(codexContext("target-personal", "personal")));
  const output = createOutput();
  let fetchCalls = 0;

  const code = await runCli([
    "architectures",
    "observe",
    "--root",
    root,
    "--profile",
    "personal",
    "--context",
    contextPath,
    "--json",
  ], testRuntime(output, async () => {
    fetchCalls += 1;
    return response(500, {});
  }, {}, fixedCodexClock));

  assert.equal(code, 0);
  assert.equal(fetchCalls, 0);
  const observation = JSON.parse(output.stdout.join("\n"));
  assert.deepEqual(assertValidArchitectureTargetObservation(observation), observation);
  assert.equal(observation.targetId, "target-personal");
  assert.equal(observation.metadata.profile, "personal");
  assert.deepEqual(observation.skills.map((skill: { slug: string }) => skill.slug), ["shared-tool", "personal-only"]);
  const serialized = output.stdout.join("\n");
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(contextPath), false);
  assert.equal(serialized.includes("PERSONAL_BODY_MUST_NOT_BE_EMITTED"), false);
});

test("codex health accepts all explicit context flags and returns unavailable without implicit discovery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-cli-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missingRoot = path.join(root, "missing-profile");
  const output = createOutput();
  let fetchCalls = 0;

  const code = await runCli([
    "architectures",
    "health",
    "--root",
    missingRoot,
    "--profile",
    "work",
    "--target-id",
    "target-work",
    "--generation",
    "2",
    "--architecture-id",
    "architecture-work",
    "--environment-id",
    "environment-work",
    "--profile-id",
    "profile-work",
    "--adapter-digest",
    "a".repeat(64),
    "--capabilities-digest",
    "b".repeat(64),
    "--json",
  ], testRuntime(output, async () => {
    fetchCalls += 1;
    return response(500, {});
  }, {}, fixedCodexClock));

  assert.equal(code, 0);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(JSON.parse(output.stdout.join("\n")), {
    status: "unavailable",
    checkedAt: "2026-08-30T00:00:00.000Z",
    metadata: {
      architectureId: "architecture-work",
      profile: "work",
      skillCount: 0,
      findingCount: 1,
    },
  });
  assert.equal(output.stdout.join("\n").includes(missingRoot), false);
});

test("codex observe preserves profile isolation and deterministic JSON output", async (t) => {
  const personalRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-cli-personal-isolation-"));
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-cli-work-isolation-"));
  t.after(() => Promise.all([
    rm(personalRoot, { recursive: true, force: true }),
    rm(workRoot, { recursive: true, force: true }),
  ]));
  await writeCodexFixture(personalRoot, "personal", ["personal-only"]);
  await writeCodexFixture(workRoot, "work", ["work-only"]);
  const personalArgs = codexFlagArgs(personalRoot, "personal", "target-personal");
  const workArgs = codexFlagArgs(workRoot, "work", "target-work");
  const firstOutput = createOutput();
  const secondOutput = createOutput();

  assert.equal(await runCli(["architectures", "observe", ...personalArgs, "--json"], testRuntime(firstOutput, undefined, {}, fixedCodexClock)), 0);
  assert.equal(await runCli(["architectures", "observe", ...personalArgs, "--json"], testRuntime(secondOutput, undefined, {}, fixedCodexClock)), 0);
  assert.deepEqual(firstOutput.stdout, secondOutput.stdout);
  assert.equal(await runCli(["architectures", "observe", ...workArgs, "--json"], testRuntime(firstOutput, undefined, {}, fixedCodexClock)), 0);

  const personalObservation = JSON.parse(firstOutput.stdout[0] ?? "{}");
  const workObservation = JSON.parse(firstOutput.stdout[1] ?? "{}");
  assert.deepEqual(personalObservation.skills.map((skill: { slug: string }) => skill.slug), ["personal-only"]);
  assert.deepEqual(workObservation.skills.map((skill: { slug: string }) => skill.slug), ["work-only"]);
  assert.equal(JSON.stringify(personalObservation).includes("work-only"), false);
  assert.equal(JSON.stringify(workObservation).includes("personal-only"), false);
});

test("codex observation rejects relative roots, invalid context files, and network/output options without echoing input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-cli-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contextPath = path.join(root, "invalid-context.json");
  await writeFile(contextPath, JSON.stringify({
    targetId: "target-invalid",
    targetGeneration: 1,
    architectureId: "architecture-invalid",
    environmentId: "environment-invalid",
    profileId: "profile-invalid",
    adapterDigest: "a".repeat(64),
    capabilitiesDigest: "b".repeat(64),
    privatePath: "PRIVATE_CONTEXT_VALUE_MUST_NOT_BE_ECHOED",
  }));
  let fetchCalls = 0;
  const fetch: FetchLike = async () => {
    fetchCalls += 1;
    return response(500, {});
  };

  const relativeOutput = createOutput();
  const relativeCode = await runCli([
    "architectures",
    "observe",
    "--root",
    "relative-codex-root",
    "--profile",
    "personal",
    "--context",
    contextPath,
  ], testRuntime(relativeOutput, fetch));
  assert.equal(relativeCode, 2);
  assert.match(relativeOutput.stderr.join("\n"), /absolute --root/);
  assert.equal(relativeOutput.stderr.join("\n").includes("relative-codex-root"), false);

  const contextOutput = createOutput();
  const contextCode = await runCli([
    "architectures",
    "observe",
    "--root",
    `${root}/safe-root`,
    "--profile",
    "personal",
    "--context",
    contextPath,
    "--api-url",
    "https://must-not-be-used.example",
  ], testRuntime(contextOutput, fetch));
  assert.equal(contextCode, 2);
  assert.match(contextOutput.stderr.join("\n"), /metadata context options/);
  assert.equal(contextOutput.stderr.join("\n").includes("PRIVATE_CONTEXT_VALUE_MUST_NOT_BE_ECHOED"), false);
  assert.equal(contextOutput.stderr.join("\n").includes("must-not-be-used.example"), false);
  assert.equal(fetchCalls, 0);
});

test("architecture dry-run human output neutralizes terminal control characters", async (t) => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "myskills-observed-state-terminal-"));
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, "observed.json");
  await writeFile(fixturePath, JSON.stringify({
    schemaVersion: "myskills.observed-state.v1",
    environment: {
      environmentKey: "personal-local",
      toolKind: "codex",
      adapterVersion: "fixture-1",
      capabilities: { canInstall: true },
    },
    inventory: [{ kind: "skill", ref: "skill.release-notes", slug: "release-notes-helper", source: "local" }],
  }));
  const output = createOutput();
  const code = await runCli([
    "architectures",
    "plan",
    "arch-1",
    "--observed",
    fixturePath,
    "--api-url",
    "http://api.test",
    "--token",
    "architecture-token",
  ], testRuntime(output, async () => response(200, {
    plan: {
      status: "changes\u001b[31m",
      changes: [{
        type: "update",
        subject: "release-notes-helper\u001b[2J\nforged-row",
        detail: "safe\tcolumn\u0007",
      }],
    },
  })));

  assert.equal(code, 0);
  const rendered = output.stdout.join("\n");
  assert.equal(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u.test(rendered), false);
  assert.equal(output.stdout.length, 2);
  assert.match(output.stdout[0] ?? "", /^dry-run\tchanges \[31m\tchanges=1$/);
  assert.match(output.stdout[1] ?? "", /^change\tupdate\trelease-notes-helper \[2J forged-row\tsafe column $/);
});

test("skills edit visibility remains a deprecated compatibility alias", async () => {
  const output = createOutput();
  let url = "";
  let body: Record<string, unknown> = {};
  const code = await runCli([
    "skills",
    "edit",
    "release-notes-helper",
    "--visibility",
    "organization",
    "--api-url",
    "http://api.test",
    "--token",
    "maintainer-token",
  ], testRuntime(output, async (input, init) => {
    url = String(input);
    body = JSON.parse(init?.body ?? "{}");
    return response(200, {
      skill: {
        slug: "release-notes-helper",
        title: "Release Notes Assistant",
        lifecycleStatus: "approved",
        visibility: "organization",
      },
    });
  }));

  assert.equal(code, 0);
  assert.equal(url, "http://api.test/v1/skills/release-notes-helper");
  assert.deepEqual(body, { visibility: "organization" });
  assert.deepEqual(output.stdout, ["release-notes-helper\tRelease Notes Assistant\tapproved\torganization"]);
  assert.match(output.stderr.join("\n"), /skills edit --visibility/);
  assert.match(output.stderr.join("\n"), /myskills sharing set <skill-slug> --visibility <scope>/);
});

test("deprecated skills edit rejects organization grant controls", async () => {
  const output = createOutput();
  let calls = 0;
  const code = await runCli([
    "skills",
    "edit",
    "release-notes-helper",
    "--visibility",
    "organization",
    "--clear-organizations",
    "--api-url",
    "http://api.test",
    "--token",
    "maintainer-token",
  ], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /Organization grant options are only supported by myskills sharing set/);
});

test("export writes verified bundle files under output directory", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "myskills-export-"));
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
    return response(200, releaseBody("0.1.0", bundle));
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
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "myskills-export-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = createOutput();
  const bundle = JSON.stringify({
    files: [{ path: "../secret.txt", content: "nope" }],
  });
  const fetch: FetchLike = async (input) => {
    if (String(input).endsWith("/bundle?platform=codex")) {
      return rawResponse(200, bundle);
    }
    return response(200, releaseBody("0.1.0", bundle));
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

test("install downloads the latest verified bundle and records local state", async (t) => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-install-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const output = createOutput();
  const bundle = bundleText("0.2.0");
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push(`${init?.headers?.authorization ?? ""} ${String(input)}`);
    if (String(input).endsWith("/v1/skills/release-notes-helper")) {
      return response(200, {
        skill: {
          slug: "release-notes-helper",
          title: "Release Notes Helper",
          summary: "Turns merged changes into concise release notes.",
          latestVersion: "0.2.0",
          platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
          tags: [],
        },
      });
    }
    if (String(input).endsWith("/releases/0.2.0")) {
      return response(200, releaseBody("0.2.0", bundle));
    }
    return rawResponse(200, bundle);
  };

  const code = await runCli([
    "install",
    "release-notes-helper",
    "--dir",
    installRoot,
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "install-token" }));

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    "Bearer install-token http://api.test/v1/skills/release-notes-helper",
    "Bearer install-token http://api.test/v1/skills/release-notes-helper/releases/0.2.0",
    "Bearer install-token http://api.test/v1/skills/release-notes-helper/releases/0.2.0/bundle?platform=codex",
  ]);
  assert.equal(await readFile(path.join(installRoot, "release-notes-helper", "README.md"), "utf8"), "Release notes helper 0.2.0");
  assert.match(output.stdout[0], /release-notes-helper@0\.2\.0\tinstalled\tplatform=codex/);

  const registry = JSON.parse(await readFile(path.join(installRoot, ".myskills-app", "installed.json"), "utf8"));
  assert.equal(registry.installations["release-notes-helper"].version, "0.2.0");
  assert.equal(registry.installations["release-notes-helper"].platform, "codex");
  assert.equal(registry.installations["release-notes-helper"].history.length, 0);
});

test("list prints local installed skills without registry calls", async (t) => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-install-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  await mkdir(path.join(installRoot, ".myskills-app"), { recursive: true });
  await writeFile(path.join(installRoot, ".myskills-app", "installed.json"), JSON.stringify({
    version: 1,
    installations: {
      "release-notes-helper": {
        version: "0.2.0",
        platform: "codex",
        installedAt: "2026-06-04T00:00:00.000Z",
        artifact: { sha256: "abc", byteSize: 123 },
        history: [],
      },
    },
  }));
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["list", "--dir", installRoot], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }));

  assert.equal(code, 0);
  assert.equal(calls, 0);
  assert.deepEqual(output.stdout, [`release-notes-helper\t0.2.0\tcodex\t${path.join(installRoot, "release-notes-helper")}`]);
});

test("update stores a rollback snapshot and rollback restores it", async (t) => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-install-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const output = createOutput();
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/skills/release-notes-helper")) {
      return response(200, {
        skill: {
          slug: "release-notes-helper",
          latestVersion: "0.2.0",
          platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
          tags: [],
        },
      });
    }
    if (url.endsWith("/bundle?platform=codex")) {
      const version = url.includes("/0.2.0/") ? "0.2.0" : "0.1.0";
      return rawResponse(200, bundleText(version));
    }
    const version = url.endsWith("/releases/0.2.0") ? "0.2.0" : "0.1.0";
    return response(200, releaseBody(version, bundleText(version)));
  };

  const install = await runCli([
    "install",
    "release-notes-helper",
    "--version",
    "0.1.0",
    "--platform",
    "codex",
    "--dir",
    installRoot,
  ], testRuntime(output, fetch));
  assert.equal(install, 0);
  assert.equal(await readFile(path.join(installRoot, "release-notes-helper", "README.md"), "utf8"), "Release notes helper 0.1.0");

  const update = await runCli(["update", "release-notes-helper", "--dir", installRoot], testRuntime(output, fetch));
  assert.equal(update, 0);
  assert.equal(await readFile(path.join(installRoot, "release-notes-helper", "README.md"), "utf8"), "Release notes helper 0.2.0");
  let registry = JSON.parse(await readFile(path.join(installRoot, ".myskills-app", "installed.json"), "utf8"));
  assert.equal(registry.installations["release-notes-helper"].version, "0.2.0");
  assert.equal(registry.installations["release-notes-helper"].history[0].version, "0.1.0");

  const rollback = await runCli(["rollback", "release-notes-helper", "--dir", installRoot], testRuntime(output, fetch));
  assert.equal(rollback, 0);
  assert.equal(await readFile(path.join(installRoot, "release-notes-helper", "README.md"), "utf8"), "Release notes helper 0.1.0");
  registry = JSON.parse(await readFile(path.join(installRoot, ".myskills-app", "installed.json"), "utf8"));
  assert.equal(registry.installations["release-notes-helper"].version, "0.1.0");
  assert.deepEqual(registry.installations["release-notes-helper"].history, []);
  assert.match(output.stdout.join("\n"), /release-notes-helper@0\.2\.0\tupdated\tplatform=codex\tprevious=0\.1\.0/);
  assert.match(output.stdout.join("\n"), /release-notes-helper@0\.1\.0\trolled-back\tplatform=codex/);
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
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "session-token" }));

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

  const code = await runCli(["token", "list"], testRuntime(output, fetch, { MYSKILLS_TOKEN: "session-token" }));

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

  const code = await runCli(["token", "revoke", "api-token-1", "--api-url", "http://api.test", "--token", "explicit-token"], testRuntime(output, fetch, { MYSKILLS_TOKEN: "env-token" }));

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
  }, { MYSKILLS_TOKEN: "session-token" }));

  assert.equal(code, 2);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /--scope is required/);
});

const fixedCodexClock = () => new Date("2026-08-30T00:00:00.000Z");

function codexContext(targetId: string, profileId: string): Record<string, unknown> {
  return {
    targetId,
    targetGeneration: 1,
    architectureId: "architecture-1",
    environmentId: `${profileId}-environment`,
    profileId,
    adapterDigest: "a".repeat(64),
    capabilitiesDigest: "b".repeat(64),
  };
}

function codexFlagArgs(root: string, profile: "personal" | "work" | "shared", targetId: string): string[] {
  const context = codexContext(targetId, profile);
  return [
    "--root",
    root,
    "--profile",
    profile,
    "--target-id",
    String(context.targetId),
    "--generation",
    String(context.targetGeneration),
    "--architecture-id",
    String(context.architectureId),
    "--environment-id",
    String(context.environmentId),
    "--profile-id",
    String(context.profileId),
    "--adapter-digest",
    String(context.adapterDigest),
    "--capabilities-digest",
    String(context.capabilitiesDigest),
  ];
}

async function writeCodexFixture(root: string, profile: "personal" | "work" | "shared", slugs: string[]): Promise<void> {
  await mkdir(path.join(root, "skills"), { recursive: true });
  await writeFile(path.join(root, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    profile,
    skills: slugs.map((slug) => ({ slug, enabled: true, runtimeExposure: "leaf" })),
  }));
  await writeFile(path.join(root, "router-policy.json"), JSON.stringify({ schemaVersion: 1, routers: [] }));
  for (const slug of slugs) {
    await mkdir(path.join(root, "skills", slug), { recursive: true });
    await writeFile(path.join(root, "skills", slug, "SKILL.md"), [
      "---",
      `slug: ${slug}`,
      "version: 1.0.0",
      `digest: ${createHash("sha256").update(slug).digest("hex")}`,
      "kind: leaf",
      "---",
      `${profile.toUpperCase()}_BODY_MUST_NOT_BE_EMITTED`,
      "",
    ].join("\n"));
  }
}

async function writeManifest(dir: string): Promise<void> {
  await writeFile(path.join(dir, "skill.json"), manifestJson());
}

function manifestJson(): string {
  return JSON.stringify({
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
  });
}

function bundleText(version: string): string {
  return JSON.stringify({
    files: [
      { path: "README.md", content: `Release notes helper ${version}` },
      { path: "skill.json", content: manifestJson() },
    ],
  });
}

function releaseBody(version: string, bundle: string) {
  return {
    release: {
      slug: "release-notes-helper",
      title: "Release Notes Helper",
      summary: "Turns merged changes into concise release notes.",
      version,
      platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
      artifact: {
        sha256: createHash("sha256").update(bundle).digest("hex"),
        byteSize: Buffer.byteLength(bundle),
        contentType: "application/vnd.myskills-app.package+json",
      },
    },
  };
}

function sharingSettingsBody() {
  return {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
    organizationVisibilityEnabled: true,
  };
}

function assertPackageManifestMatchesBody(body: { manifest?: { name?: string; version?: string; title?: string }; files?: Array<{ path: string; content: string }> }): void {
  const packageManifest = JSON.parse(body.files?.find((file) => file.path === "skill.json")?.content ?? "{}");
  assert.equal(packageManifest.name, body.manifest?.name);
  assert.equal(packageManifest.version, body.manifest?.version);
  assert.equal(packageManifest.title, body.manifest?.title);
}

async function makeTempPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "myskills-cli-"));
}

function createOutput(): { stdout: string[]; stderr: string[] } {
  return { stdout: [], stderr: [] };
}

function testRuntime(
  output: { stdout: string[]; stderr: string[] },
  fetch: FetchLike = async () => response(500, {}),
  env: Record<string, string | undefined> = {},
  codexAdapterClock?: () => Date,
) {
  return {
    env,
    fetch,
    ...(codexAdapterClock ? { codexAdapterClock } : {}),
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

function rawResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    headers,
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}
