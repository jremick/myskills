import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { defaultSkillUpgradePolicyV1 } from "@myskills-app/core";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { buildApp } from "../../api/src/app.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { MemoryOrganizationStore } from "../../api/src/organizations/memory-organization-store.js";
import { OrganizationService } from "../../api/src/organizations/service.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../api/src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../api/src/submissions/service.js";
import { MemoryTeamStore } from "../../api/src/teams/memory-team-store.js";
import { TeamService } from "../../api/src/teams/service.js";
import { MemorySkillUpgradePolicyStore } from "../../api/src/upgrade-policies/memory-store.js";
import { SkillUpgradePolicyService } from "../../api/src/upgrade-policies/service.js";
import { runCli, type CliRuntime, type StoredCliToken } from "../src/cli.js";

// Authoring ledger: these journeys protect the CLI-to-API contract, not duplicated
// service logic. Existing API tests cannot detect missing CLI dispatch, lost JSON
// fields/revision guards, malformed paths, or exported package contents. Credible
// failures include wrong verbs/paths, discarded consent-related fields, bypassed
// authentication, exposed foreign submissions, and accepting a stale policy write.
// All requests below traverse the real Fastify routes, auth service and stores.

test("CLI organization journey preserves membership, policy revision and team boundaries", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner", true);
  const member = await f.login("member", true);
  const created = await owner.ok(["organizations", "create", "Platform", "--slug", "cli-platform"]);
  const id = created.organization.id as string;
  const initialPolicy = created.organization.currentPolicy.id as string;
  assert.deepEqual((await owner.ok(["organizations", "list"])).organizations.map((item) => item.id), [id]);
  assert.equal((await owner.ok(["organizations", "show", id])).organization.role, "owner");
  await member.fail(["organizations", "show", id], /ORGANIZATION_NOT_FOUND/);

  const invitation = (await owner.ok(["organizations", "invite", id, "--email", "member@example.com", "--role", "member"])).invitation;
  assert.equal((await owner.ok(["organizations", "invitations", id])).invitations[0].id, invitation.id);
  assert.equal((await member.ok(["organizations", "pending-invitations"])).invitations[0].id, invitation.id);
  assert.equal((await member.ok(["organizations", "accept", invitation.id])).invitation.status, "accepted");
  assert.equal((await member.ok(["organizations", "members", id])).members.length, 2);
  await member.fail(["organizations", "archive", id], /ORGANIZATION_OWNER_REQUIRED/);
  await owner.fail(["organizations", "remove-member", id, "owner"], /LAST_ORGANIZATION_OWNER_REQUIRED/);
  assert.equal((await owner.ok(["organizations", "set-role", id, "member", "--role", "admin"])).member.role, "admin");

  const policyInput = await f.input("policy", {
    policy: { sharing: { organizationArchitectureSharingEnabled: false } },
    reason: "Review architecture sharing before restoring the prior policy.",
  });
  const nextPolicy = await owner.ok(["organizations", "append-policy", id, "--input", policyInput]);
  assert.equal(nextPolicy.revision.revisionNumber, 2);
  assert.equal(nextPolicy.revision.reason, "Review architecture sharing before restoring the prior policy.");
  assert.equal((await owner.ok(["organizations", "policies", id])).revisions.length, 2);
  assert.equal((await owner.ok(["organizations", "activate-policy", id, initialPolicy])).revision.id, initialPolicy);

  assert.equal((await owner.ok(["organizations", "update-policy", id])).revision, null);
  const upgradeInput = await f.input("upgrade", { policy: defaultSkillUpgradePolicyV1, expectedRevisionNumber: 0, reason: "Pin reviewed upgrades." });
  assert.equal((await owner.ok(["organizations", "set-update-policy", id, "--input", upgradeInput])).revision.reason, "Pin reviewed upgrades.");
  await owner.fail(["organizations", "set-update-policy", id, "--input", upgradeInput], /SKILL_UPGRADE_POLICY_REVISION_CONFLICT/);
  assert.equal((await owner.ok(["organizations", "update-policy", id])).revision.revisionNumber, 1);

  const childInput = await f.input("child", { name: "Platform Child", slug: "platform-child" });
  const child = (await owner.ok(["organizations", "create-team", id, "--input", childInput])).team;
  assert.equal(child.organizationId, id);
  const standalone = (await owner.ok(["teams", "create", "Adoptable Team"])).team;
  assert.equal((await owner.ok(["organizations", "adopt-team", id, standalone.id])).team.organizationId, id);
  assert.deepEqual(new Set((await owner.ok(["organizations", "teams", id])).teams.map((item) => item.id)), new Set([child.id, standalone.id]));

  await owner.ok(["organizations", "remove-member", id, "member"]);
  await member.fail(["organizations", "show", id], /ORGANIZATION_NOT_FOUND/);
  assert.equal((await owner.ok(["organizations", "archive", id])).organization.status, "archived");
  assert.deepEqual((await owner.ok(["organizations", "list"])).organizations, []);
});

test("CLI team lifecycle rejects non-owners and preserves the final owner", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner", true);
  const member = await f.login("member", true);
  const team = (await owner.ok(["teams", "create", "Lifecycle Team"])).team;
  const pending = (await owner.ok(["teams", "invite", team.id, "--email", "pending@example.com"])).invitation;
  await member.fail(["teams", "revoke-invitation", team.id, pending.id], /TEAM_OWNER_REQUIRED/);
  assert.equal((await owner.ok(["teams", "revoke-invitation", team.id, pending.id])).invitation.status, "revoked");
  const invitation = (await owner.ok(["teams", "invite", team.id, "--email", "member@example.com"])).invitation;
  await member.ok(["teams", "accept", invitation.id]);
  await member.fail(["teams", "set-role", team.id, "owner", "--role", "member"], /TEAM_OWNER_REQUIRED/);
  await owner.fail(["teams", "remove-member", team.id, "owner"], /LAST_OWNER_REQUIRED/);
  assert.equal((await owner.ok(["teams", "set-role", team.id, "member", "--role", "owner"])).member.role, "owner");
  await owner.ok(["teams", "set-role", team.id, "owner", "--role", "member"]);
  assert.equal((await member.ok(["teams", "remove-member", team.id, "owner"])).member.id, "owner");
  assert.deepEqual((await owner.ok(["teams", "list"])).teams, []);
});

test("CLI managed inventory and submission detail/export retain private author and reviewer access", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner", true);
  const author = await f.login("author", false);
  const outsider = await f.login("member", false);
  const submissions = [];
  for (const slug of ["collaboration-alpha", "collaboration-beta"]) {
    const manifest = parseSkillManifest({
      name: slug, title: slug, summary: "A private CLI collaboration fixture.", version: "1.0.0", license: "Apache-2.0",
      visibility: "private", platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["workflow"],
    });
    const submitted = await f.api("POST", "/v1/submissions", author.token(), {
      manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: "Private workflow instructions.\n" }],
    });
    assert.equal(submitted.statusCode, 202);
    submissions.push(submitted.json().submission);
  }
  const first = await author.ok(["skills", "managed", "--limit", "1"]);
  assert.deepEqual(first.skills.map((item) => item.slug), ["collaboration-alpha"]);
  assert.equal(typeof first.nextCursor, "string");
  assert.ok(first.nextCursor);
  const second = await author.ok(["skills", "managed", "--limit", "1", "--cursor", first.nextCursor]);
  assert.deepEqual(second.skills.map((item) => item.slug), ["collaboration-beta"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await author.ok(["skills", "managed", "--query", "beta"])).skills.map((item) => item.slug), ["collaboration-beta"]);
  assert.deepEqual((await outsider.ok(["skills", "managed"])).skills, []);

  const id = submissions[0].id;
  await owner.ok(["review", "action", id, "--action", "request-changes", "--reason", "Explain setup and expected permissions."]);
  const detail = (await author.ok(["submissions", "show", id])).submission;
  assert.equal(detail.changeRequestReason, "Explain setup and expected permissions.");
  assert.equal(detail.reviewHistory[0].action, "request-changes");
  assert.equal((await owner.ok(["review", "show", id])).submission.id, id);
  await author.fail(["review", "show", id], /MFA_REQUIRED|REVIEW_ROLE_REQUIRED/);
  await outsider.fail(["submissions", "show", id], /SUBMISSION_NOT_FOUND/);

  const output = path.join(f.directory, "submission-package.json");
  await author.ok(["submissions", "export", id, "--platform", "codex", "--output", output]);
  const exported = JSON.parse(await readFile(output, "utf8")) as { files: Array<{ path: string; content: string }> };
  assert.equal(exported.files.find((file) => file.path === "SKILL.md")?.content, "Private workflow instructions.\n");
  assert.equal(JSON.stringify(exported).includes("storageKey"), false);
  const forbidden = path.join(f.directory, "forbidden.json");
  await outsider.fail(["submissions", "export", id, "--output", forbidden], /SUBMISSION_NOT_FOUND/);
  await assert.rejects(readFile(forbidden), { code: "ENOENT" });
});

test("CLI collaboration rejects bad arguments before requests and leaves session/MFA enforcement to the API", async (t) => {
  const f = await fixture(t);
  const owner = await f.login("owner", true);
  for (const args of [
    ["organizations", "show", "../teams"],
    ["organizations", "set-role", "org-1", "member", "--role", "superadmin"],
    ["teams", "set-role", "team-1", "member", "--role", "admin"],
    ["skills", "managed", "--limit", "101"],
    ["skills", "managed", "--platform", "codex"],
    ["submissions", "export", "submission-1", "--platform", "../codex"],
    ["organizations", "create", "One", "--input", "ambiguous.json"],
    ["organizations", "archive", "org-1", "unexpected"],
  ]) {
    const before = f.requests();
    await owner.fail(args, /Usage:|Invalid|Unsupported|cannot|must|required/i);
    assert.equal(f.requests(), before, args.join(" "));
  }
  const unverified = await f.login("author", false);
  await unverified.fail(["organizations", "create", "Unverified"], /MFA_VERIFICATION_REQUIRED/);
  const tokenResponse = await f.api("POST", "/v1/auth/api-tokens", owner.token(), { name: "read token", scopes: ["profile:read"] });
  assert.equal(tokenResponse.statusCode, 201);
  const apiTokenClient = f.client(tokenResponse.json().token.token, "api");
  await apiTokenClient.fail(["organizations", "list"], /API_TOKEN_SCOPE_REQUIRED/);
});

interface CommandResult {
  organization: { id: string; role: string; status: string; currentPolicy: { id: string } };
  organizations: Array<{ id: string }>;
  invitation: { id: string; status: string };
  invitations: Array<{ id: string }>;
  member: { id: string; role: string };
  members: Array<{ id: string }>;
  revision: { id: string; revisionNumber: number; reason: string };
  revisions: Array<{ id: string }>;
  team: { id: string; organizationId: string | null };
  teams: Array<{ id: string }>;
  skills: Array<{ slug: string }>;
  nextCursor: string | null;
  submission: { id: string; changeRequestReason: string; reviewHistory: Array<{ action: string }> };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-collaboration-parity-"));
  const authStore = new MemoryAuthStore("closed");
  const organizationStore = new MemoryOrganizationStore();
  const teamStore = new MemoryTeamStore({ organizationStore });
  const teamService = new TeamService(teamStore);
  const password = "correct horse battery staple";
  const passwordHash = await hashPassword(password);
  for (const [id, roles] of [["owner", ["owner"]], ["member", ["user"]], ["author", ["author"]]] as const) {
    const user = { id, email: `${id}@example.com`, name: id, roles: [...roles], status: "active" as const, emailVerifiedAt: new Date(), passwordHash };
    authStore.addUser(user);
    organizationStore.addKnownUser(user);
    teamStore.addKnownUser(user);
  }
  const app = buildApp({
    authService: new AuthService(authStore), skillRepository: new MemorySkillRepository([]),
    teamService, organizationService: new OrganizationService(organizationStore, teamService),
    submissionService: new SubmissionService(new MemorySubmissionStore()),
    skillUpgradePolicyService: new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore()),
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let requestCount = 0;
  const api = (method: "POST" | "GET", url: string, token?: string, payload?: Record<string, unknown>) => app.inject({
    method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload,
  });
  const client = (rawToken: string, kind: "session" | "api" = "session") => {
    let stored: StoredCliToken | null = { token: rawToken, kind };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime: CliRuntime = {
      env: {}, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      tokenStore: {
        get: async () => stored, set: async (_url, value) => { stored = value; }, delete: async () => { stored = null; },
        describe: () => ({ backend: "memory" }),
      },
      fetch: async (input, init) => {
        requestCount += 1;
        const url = new URL(input);
        const result = await app.inject({ method: init?.method ?? "GET", url: `${url.pathname}${url.search}`, headers: init?.headers, payload: init?.body });
        return { ok: result.statusCode >= 200 && result.statusCode < 300, status: result.statusCode, headers: result.headers as Record<string, string>, text: async () => result.body };
      },
    };
    async function run(args: string[]) {
      stdout.length = 0; stderr.length = 0;
      return runCli([...args, "--api-url", "http://api.test", "--json"], runtime);
    }
    return {
      token: () => stored?.token ?? "",
      async ok(args: string[]): Promise<CommandResult> {
        assert.equal(await run(args), 0, `${args.join(" ")}: ${stderr.join("\n")}`);
        return (stdout.length ? JSON.parse(stdout.join("\n")) : {}) as CommandResult;
      },
      async fail(args: string[], pattern: RegExp) {
        assert.notEqual(await run(args), 0, args.join(" "));
        assert.match(stderr.join("\n"), pattern);
      },
    };
  };
  return {
    app, api, directory, client, requests: () => requestCount,
    async input(name: string, value: Record<string, unknown>) {
      const file = path.join(directory, `${name}.json`);
      await writeFile(file, JSON.stringify(value));
      return file;
    },
    async login(id: string, withMfa: boolean) {
      const login = await api("POST", "/v1/auth/login", undefined, { email: `${id}@example.com`, password });
      assert.equal(login.statusCode, 200);
      let token = login.json().token as string;
      if (withMfa) {
        const enroll = await api("POST", "/v1/auth/mfa/totp/enroll", token, { password });
        assert.equal(enroll.statusCode, 201);
        const confirmed = await api("POST", "/v1/auth/mfa/totp/confirm", token, { factorId: enroll.json().enrollment.factorId, code: generateTotpCode(enroll.json().enrollment.secret) });
        assert.equal(confirmed.statusCode, 200);
        const challenge = await api("POST", "/v1/auth/login", undefined, { email: `${id}@example.com`, password });
        assert.equal(challenge.statusCode, 200);
        const verified = await api("POST", "/v1/auth/mfa/verify", undefined, { challengeToken: challenge.json().challengeToken, recoveryCode: confirmed.json().mfa.recoveryCodes[0] });
        assert.equal(verified.statusCode, 200);
        token = verified.json().token;
      }
      return client(token);
    },
  };
}
