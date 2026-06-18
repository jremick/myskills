import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, type FetchLike } from "../src/cli.js";
import { writeStoredZip } from "../../../test-support/zip-fixture.js";

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
  ], testRuntime(output, fetch, { MYSKILLS_TOKEN: "review-token" }));

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

test("sharing set posts visibility, team grants, and user grants", async () => {
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
      },
    },
  ]);
  assert.deepEqual(output.stdout, [
    "public=disabled\tauthenticated=enabled\tteams=enabled\tteam-visibility=enabled\tuser-visibility=disabled",
  ]);
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
