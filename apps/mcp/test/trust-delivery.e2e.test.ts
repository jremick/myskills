import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { hashSessionToken } from "@myskills-app/auth";
import type { PublicSkill } from "@myskills-app/core";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { z } from "zod";
import { buildApp } from "../../api/src/app.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../api/src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../api/src/submissions/service.js";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
import { SKILLS_EXTENSION } from "../src/skills.js";

// Written before delivery implementation. Protect the real socket boundary:
// stale identity, invalid credentials, revocation during storage, altered bytes,
// team/lifecycle denial, cross-origin/traversal resources and sanitized audit.
// Existing fixture-only native tests cannot detect API authorization races.
const listSchema = z.object({ skills: z.array(z.object({ uri: z.string() }).passthrough()) }).passthrough();

test("direct delivery binds exact releases, rejects stale digest before reading and fails invalid bearer closed", async (t) => {
  const f = await fixture(t);
  const first = await f.publish("public-notes", "public", "1.0.0");
  await f.publish("public-notes", "public", "1.1.0");
  const read = await f.request(first, f.token);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal(read.headers.get("x-myskills-artifact-sha256"), first.artifact.sha256);
  const bytes = await read.text();
  assert.equal(Buffer.byteLength(bytes), first.artifact.byteSize);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), first.artifact.sha256);
  assert.match(bytes, /version 1.0.0/);
  let reads = 0;
  const original = f.submissions.getPublicBundle.bind(f.submissions);
  t.mock.method(f.submissions, "getPublicBundle", async (...args: Parameters<typeof original>) => { reads++; return original(...args); });
  const stale = await f.request(first, f.token, "0".repeat(64));
  assert.equal(stale.status, 409);
  assert.equal(reads, 0, "digest mismatch must fail before object retrieval");
  const malformed = await f.request(first, f.token, "../private-object");
  assert.equal(malformed.status, 400);
  assert.equal((await f.request(first, "synthetic-invalid-supplied-credential")).status, 401);
  assert.equal((await f.request(first)).status, 200, "existing public anonymous access is retained");
  assert.equal((await f.request(first, f.wrongScope)).status, 403);
});

for (const change of ["credential", "metadata-credential", "account", "scope", "membership", "policy", "lifecycle", "bytes", "deadline"] as const) {
  test(`direct delivery rechecks ${change} changed during object retrieval`, async (t) => {
    const f = await fixture(t);
    const release = await f.publish("team-notes", "team", "1.0.0");
    const original = f.submissions.getPublicBundle.bind(f.submissions);
    if (change === "metadata-credential") {
      const metadata = f.submissions.getPublicRelease.bind(f.submissions);
      let calls = 0;
      t.mock.method(f.submissions, "getPublicRelease", async (...args: Parameters<typeof metadata>) => {
        const result = await metadata(...args);
        if (++calls === 2) await f.authStore.revokeUserCredentials("reader");
        return result;
      });
    }
    t.mock.method(f.submissions, "getPublicBundle", async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      assert.ok(result);
      if (change === "credential") await f.authStore.revokeUserCredentials("reader");
      if (change === "account") f.authStore.setUserStatus("reader@example.test", "disabled");
      if (change === "scope") {
        const find = f.authStore.findUserByApiTokenHash.bind(f.authStore);
        t.mock.method(f.authStore, "findUserByApiTokenHash", async (hash: string) => {
          const user = await find(hash);
          return user ? { ...user, apiTokenScopes: ["architectures:read"] } : null;
        });
      }
      if (change === "membership") f.submissions.removeTeamMembership("reader", "team");
      if (change === "policy") f.submissions.setSharingSettings({ teamVisibilityEnabled: false });
      if (change === "lifecycle") await f.service.performReleaseAction({ actor: f.maintainer, slug: release.slug, version: release.version, action: "revoke" });
      if (change === "deadline") t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 16_001 });
      if (change === "bytes") return { ...result, payload: { files: result.payload.files.map(file => ({ ...file, content: file.content.replace("version", "altered") })) } };
      return result;
    });
    const response = await f.request(release, f.token);
    assert.equal(response.status, change === "credential" || change === "metadata-credential" || change === "account" ? 401 : change === "scope" ? 403 : change === "bytes" ? 500 : change === "deadline" ? 504 : 404);
    const error = await response.text();
    assert.equal(error.includes("Private package instructions"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const audit = await f.authStore.listAuditEvents({ limit: 100 });
    assert.ok(audit.some(row => row.action === "delegated.skills.releases.export" && row.decision === "deny"));
    assert.equal(JSON.stringify(audit).includes(f.token), false);
    assert.equal(JSON.stringify(audit).includes("Private package instructions"), false);
  });
}

test("native MCP uses actual API policy for mixed visibility, immutable resources and privileged denial", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.publish("public-notes", "public", "1.0.0");
  await f.publish("team-notes", "team", "1.0.0");
  await f.publish("private-notes", "private", "1.0.0");
  const server = createAiSkillsMcpHttpServer({ apiBaseUrl: f.apiBase });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "trust-conformance", version: "1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { extensions: { [SKILLS_EXTENSION]: {} } },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${f.token}` } } }));
  t.after(() => client.close());
  const listed = await client.request({ method: "skills/list", params: {} }, listSchema);
  assert.equal(listed.skills.length, 2);
  assert.equal(listed.ttlMs, 0);
  assert.equal(listed.cacheScope, "private");
  const team = listed.skills.find(skill => skill.uri.includes("team-notes"));
  assert.ok(team);
  const exported = await client.callTool({ name: "skills_releases_export", arguments: { path: { slug: "public-notes", version: "1.0.0" }, query: { platform: "codex" } } });
  assert.equal(exported.isError, undefined);
  assert.equal((exported.structuredContent as { artifact: { verification: string } }).artifact.verification, "response_header");
  assert.match(JSON.stringify(await client.readResource({ uri: team.uri })), /Private package instructions/);
  for (const uri of [team.uri.replace("SKILL.md", "..%2Fprivate"), team.uri.replace(/\/[a-f0-9]{64}\//, `/${"0".repeat(64)}/`), team.uri.replace(/myskills-[a-f0-9]+/, "myskills-other-origin"), `${team.uri}${"x".repeat(5000)}`]) {
    await assert.rejects(client.readResource({ uri }));
  }
  const privileged = await client.callTool({ name: "admin_audit_list", arguments: {} });
  assert.equal(privileged.isError, true);
  assert.equal((privileged.structuredContent as { error: { code: string } }).error.code, "API_TOKEN_SCOPE_REQUIRED");
  f.submissions.removeTeamMembership("reader", "team");
  await assert.rejects(client.readResource({ uri: team.uri }));
  await f.authStore.revokeUserCredentials("reader");
  await assert.rejects(client.request({ method: "skills/list", params: {} }, listSchema));
  const audits = JSON.stringify(await f.authStore.listAuditEvents({ limit: 100 }));
  assert.equal(audits.includes(f.token), false);
  assert.equal(audits.includes("Private package instructions"), false);
  assert.match(audits, /delegated.skills.releases.export/);
});

async function fixture(t: TestContext) {
  const authStore = new MemoryAuthStore("closed");
  const session = "synthetic-long-trust-reader-session-fixture";
  authStore.addUser({ id: "reader", email: "reader@example.test", roles: ["user"], status: "active", emailVerifiedAt: new Date() });
  await authStore.createSession({ userId: "reader", tokenHash: hashSessionToken(session), expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: null });
  const auth = new AuthService(authStore);
  const skills: PublicSkill[] = [];
  const repo = new MemorySkillRepository(skills);
  repo.addTeamMembership("reader", { id: "team", name: "Trusted team", slug: "trusted-team" });
  const submissions = new MemorySubmissionStore({ teams: [{ id: "team" }], teamMemberships: [{ userId: "reader", teamId: "team" }], teamGrants: [{ slug: "team-notes", teamId: "team" }] });
  const service = new SubmissionService(submissions);
  const app = buildApp({ authService: auth, skillRepository: repo, submissionService: service });
  await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const apiBase = `http://127.0.0.1:${address.port}`;
  const issue = async (scopes: string[]) => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/api-tokens", headers: { authorization: `Bearer ${session}` }, payload: { name: "Trust E2E", scopes } });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().token.token as string;
  };
  const token = await issue(["skills:read"]);
  const wrongScope = await issue(["architectures:read"]);
  const maintainer = { id: "maintainer", roles: ["maintainer" as const], mfaVerified: true };
  return {
    app, apiBase, authStore, submissions, service, token, wrongScope, maintainer,
    async publish(slug: string, visibility: "public" | "team" | "private", version: string) {
      const manifest = parseSkillManifest({ name: slug, title: slug, summary: "Trust delivery notes", version, license: "MIT", visibility, platforms: [{ name: "codex", install_target: "codex-skill" }] });
      const files = [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Read trusted notes\n---\nPrivate package instructions for version ${version}.\n` }];
      const created = await service.createSubmission({ actor: { id: "author", roles: ["author"] }, manifest, files });
      await service.performReviewAction({ actor: maintainer, submissionId: created.id, action: "approve", artifactSha256: created.artifact.sha256 });
      await service.performReviewAction({ actor: maintainer, submissionId: created.id, action: "publish" });
      if (!skills.some(skill => skill.slug === slug)) skills.push({ slug, title: slug, summary: manifest.summary, latestVersion: version, visibility, lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }], tags: [] });
      if (visibility === "team") repo.addTeamGrant(slug, "team");
      return { slug, version, artifact: created.artifact };
    },
    request(release: { slug: string; version: string; artifact: { sha256: string } }, credential?: string, expected = release.artifact.sha256) {
      return fetch(`${apiBase}/v1/skills/${release.slug}/releases/${release.version}/bundle?${new URLSearchParams({ platform: "codex", sha256: expected })}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    },
  };
}
