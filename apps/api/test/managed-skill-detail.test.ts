import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword, type Role } from "@myskills-app/auth";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { apiTokenScopes } from "../src/auth/types.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import type { SubmissionActor } from "../src/submissions/types.js";

const PASSWORD = "correct horse battery staple";
const owner: SubmissionActor = { id: "managed-owner", roles: ["author"] };
const maintainer: SubmissionActor = { id: "managed-maintainer", roles: ["maintainer"] };
const ALL_SKILL_ACTIONS = ["edit", "archive", "restore", "delete"];

test("managed skill detail rejects anonymous, dead and unscoped credentials without details", async (t) => {
  const fixture = await managedFixture();
  t.after(() => fixture.app.close());
  const { app } = fixture;

  const anonymous = await app.inject({ method: "GET", url: "/v1/manage/skills/archived-helper" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, "AUTHENTICATION_REQUIRED");

  const garbage = await getDetail(app, "archived-helper", { authorization: "Bearer not-a-real-session-token" });
  assert.equal(garbage.statusCode, 401);
  assert.equal(garbage.json().error.code, "AUTHENTICATION_REQUIRED");

  const retiredSession = await login(app, "owner@example.com");
  const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${retiredSession}` } });
  assert.equal(logout.statusCode, 204);
  const afterLogout = await getDetail(app, "archived-helper", bearer(retiredSession));
  assert.equal(afterLogout.statusCode, 401);
  assert.equal(afterLogout.json().error.code, "AUTHENTICATION_REQUIRED");

  // Management is delegated only by its named scope; an ordinary read token
  // must not discover archived or unpublished management details.
  const readToken = await createApiToken(app, fixture.sessions.owner, ["skills:read"]);
  const everyScopeToken = await createApiToken(app, fixture.sessions.maintainer, [...apiTokenScopes]);
  const denied = await getDetail(app, "archived-helper", bearer(readToken));
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, "API_TOKEN_SCOPE_REQUIRED");
  assertNoSkillDetails(denied.body);
  const authorized = await getDetail(app, "archived-helper", bearer(everyScopeToken));
  assert.equal(authorized.statusCode, 200, authorized.body);
  assert.equal(authorized.json().skill.slug, "archived-helper");
});

test("owner and privileged maintainer sessions load archived and unpublished skills that match the managed inventory", async (t) => {
  const fixture = await managedFixture();
  t.after(() => fixture.app.close());
  const { app, sessions } = fixture;

  // Fixture check through the existing inventory route. These rows are the
  // source of truth the detail route must agree with.
  const inventory = await app.inject({ method: "GET", url: "/v1/manage/skills", headers: bearer(sessions.owner) });
  assert.equal(inventory.statusCode, 200, inventory.body);
  const rows = new Map((inventory.json().skills as Array<{ slug: string; lifecycleStatus: string }>).map((row) => [row.slug, row]));
  assert.equal(rows.get("archived-helper")?.lifecycleStatus, "archived");
  assert.equal(rows.get("unpublished-helper")?.lifecycleStatus, "unpublished");

  for (const [label, headers] of [
    ["owner bearer session", bearer(sessions.owner)],
    ["owner cookie session", { cookie: `theme=dark; myskills_session=${encodeURIComponent(sessions.owner)}` }],
    ["MFA-verified maintainer session", bearer(sessions.maintainer)],
  ] as const) {
    for (const slug of ["archived-helper", "unpublished-helper"]) {
      const response = await getDetail(app, slug, headers);
      assert.equal(response.statusCode, 200, `${label} ${slug}: ${response.body}`);
      const body = response.json();
      assert.deepEqual(Object.keys(body), ["skill"], `${label} ${slug}: response is exactly { skill }`);
      assert.deepEqual(body.skill, rows.get(slug), `${label} ${slug}: detail matches the inventory row`);
      assert.equal(body.skill.slug, slug);
      assert.equal(body.skill.title, `${slug} title`);
      assert.deepEqual(body.skill.tags, ["workflow"]);
      assert.deepEqual(body.skill.allowedActions, ALL_SKILL_ACTIONS);
    }
  }

  const missingForOwner = await getDetail(app, "never-submitted-helper", bearer(sessions.owner));
  assert.equal(missingForOwner.statusCode, 404, missingForOwner.body);
  assert.equal(missingForOwner.json().error.code, "SKILL_NOT_FOUND");
  const missingForMaintainer = await getDetail(app, "never-submitted-helper", bearer(sessions.maintainer));
  assert.equal(missingForMaintainer.statusCode, 404, missingForMaintainer.body);
  assert.equal(missingForMaintainer.json().error.code, "SKILL_NOT_FOUND");
});

test("non-owner author and plain reader sessions are denied management details by the existing service authority", async (t) => {
  const fixture = await managedFixture();
  t.after(() => fixture.app.close());
  const { app, sessions } = fixture;

  for (const [label, session] of [["other author", sessions.otherAuthor], ["plain reader", sessions.reader]] as const) {
    const inventory = await app.inject({ method: "GET", url: "/v1/manage/skills", headers: bearer(session) });
    assert.equal(inventory.statusCode, 200);
    assert.deepEqual(inventory.json().skills, [], `${label} manages nothing`);
    for (const slug of ["archived-helper", "unpublished-helper", "pending-helper"]) {
      const response = await getDetail(app, slug, bearer(session));
      assert.equal(response.statusCode, 403, `${label} ${slug}: ${response.body}`);
      assert.equal(response.json().error.code, "SKILL_MANAGEMENT_ROLE_REQUIRED");
      assertNoSkillDetails(response.body);
    }
  }
});

test("managed skill detail validates slugs with the shared slug parser before reaching the service", async (t) => {
  const fixture = await managedFixture();
  t.after(() => fixture.app.close());
  const { app, sessions } = fixture;

  for (const rawSlug of [
    "Archived-Helper",
    "archived--helper",
    "-archived-helper",
    "..%2Fsubmissions",
    "archived-helper%2F..%2F..%2Fadmin",
    "archived-helper%3Fq%3Dx",
    "archived%20helper",
    "archived-helper%00",
  ]) {
    const response = await app.inject({ method: "GET", url: `/v1/manage/skills/${rawSlug}`, headers: bearer(sessions.maintainer) });
    assert.equal(response.statusCode, 400, `${rawSlug}: ${response.body}`);
    assert.equal(response.json().error.code, "INVALID_SKILL_SLUG", rawSlug);
    assertNoSkillDetails(response.body);
  }

  // The parametric route must not shadow the inventory list route.
  const inventory = await app.inject({ method: "GET", url: "/v1/manage/skills?limit=1", headers: bearer(sessions.maintainer) });
  assert.equal(inventory.statusCode, 200, inventory.body);
  assert.equal(inventory.json().skills.length, 1);
  assert.ok(inventory.json().nextCursor);
});

test("managed skill detail is read-only across allowed and denied callers", async (t) => {
  const fixture = await managedFixture();
  t.after(() => fixture.app.close());
  const { app, sessions, service, store } = fixture;
  const readToken = await createApiToken(app, sessions.owner, ["skills:read"]);
  const before = await managementSnapshot(service, store);
  assert.equal(before.reviewQueue.includes("pending-helper@1.0.0:unreviewed"), true);
  assert.ok(before.audit.length > 0, "fixture setup recorded review and lifecycle audit events");

  const allowed: number[] = [];
  const denied: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    for (const slug of ["archived-helper", "unpublished-helper", "pending-helper"]) {
      allowed.push((await getDetail(app, slug, bearer(sessions.owner))).statusCode);
      allowed.push((await getDetail(app, slug, bearer(sessions.maintainer))).statusCode);
      denied.push((await getDetail(app, slug, bearer(sessions.otherAuthor))).statusCode);
      denied.push((await getDetail(app, slug, bearer(readToken))).statusCode);
    }
  }
  assert.deepEqual([...new Set(allowed)], [200]);
  assert.deepEqual([...new Set(denied)], [403]);

  // Lifecycle, release, review-queue and audit state are identical after
  // twelve allowed and twelve denied reads.
  assert.deepEqual(await managementSnapshot(service, store), before);
});

test("managed skill detail keeps the existing missing-service responses", async (t) => {
  const withoutSubmissions = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(new MemoryAuthStore("closed")),
  });
  const withoutAuth = buildApp({
    skillRepository: new MemorySkillRepository([]),
    submissionService: new SubmissionService(new MemorySubmissionStore()),
  });
  t.after(async () => {
    await withoutSubmissions.close();
    await withoutAuth.close();
  });

  const noSubmissions = await withoutSubmissions.inject({ method: "GET", url: "/v1/manage/skills/archived-helper" });
  assert.equal(noSubmissions.statusCode, 503, noSubmissions.body);
  assert.equal(noSubmissions.json().error.code, "SUBMISSION_SERVICE_UNAVAILABLE");
  const noAuth = await withoutAuth.inject({ method: "GET", url: "/v1/manage/skills/archived-helper" });
  assert.equal(noAuth.statusCode, 503, noAuth.body);
  assert.equal(noAuth.json().error.code, "AUTH_SERVICE_UNAVAILABLE");
});

async function managedFixture() {
  const authStore = new MemoryAuthStore("closed");
  const store = new MemorySubmissionStore();
  const service = new SubmissionService(store);
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    submissionService: service,
  });
  await addUser(authStore, "managed-owner", "owner@example.com", ["author"]);
  await addUser(authStore, "managed-maintainer", "maintainer@example.com", ["maintainer"]);
  await addUser(authStore, "other-author", "other-author@example.com", ["author"]);
  await addUser(authStore, "plain-reader", "reader@example.com", ["user"]);

  // archived-helper: published, then the whole skill is archived.
  // unpublished-helper: published, its only release unpublished, then the
  // skill archived and restored, which recomputes it as "unpublished".
  // pending-helper: submitted and still waiting in the review queue.
  for (const slug of ["archived-helper", "unpublished-helper"]) {
    const submission = await service.createSubmission({ actor: owner, ...packageInput(slug, "1.0.0") });
    await service.performReviewAction({ actor: maintainer, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await service.performReviewAction({ actor: maintainer, submissionId: submission.id, action: "publish" });
  }
  await service.performSkillAction({ actor: owner, slug: "archived-helper", action: "archive" });
  await service.performReleaseAction({ actor: owner, slug: "unpublished-helper", version: "1.0.0", action: "unpublish" });
  await service.performSkillAction({ actor: owner, slug: "unpublished-helper", action: "archive" });
  await service.performSkillAction({ actor: owner, slug: "unpublished-helper", action: "restore" });
  await service.createSubmission({ actor: owner, ...packageInput("pending-helper", "1.0.0") });

  return {
    app,
    service,
    store,
    sessions: {
      owner: await login(app, "owner@example.com"),
      maintainer: await loginWithMfa(app, "maintainer@example.com"),
      otherAuthor: await login(app, "other-author@example.com"),
      reader: await login(app, "reader@example.com"),
    },
  };
}

async function managementSnapshot(service: SubmissionService, store: MemorySubmissionStore) {
  const managed = await service.listManagedSkills({ actor: maintainer });
  const releases: Record<string, unknown> = {};
  for (const slug of ["archived-helper", "unpublished-helper", "pending-helper"]) {
    releases[slug] = await service.listSkillReleases({ actor: owner, slug });
  }
  const reviewQueue = (await service.listReviewSubmissions(maintainer))
    .map((submission) => `${submission.slug}@${submission.version}:${submission.reviewStatus}`)
    .sort();
  return {
    managed: managed.skills,
    releases,
    reviewQueue,
    audit: JSON.parse(JSON.stringify(store.auditEvents())) as unknown[],
  };
}

function getDetail(app: ReturnType<typeof buildApp>, slug: string, headers: Record<string, string>) {
  return app.inject({ method: "GET", url: `/v1/manage/skills/${slug}`, headers });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function assertNoSkillDetails(body: string) {
  for (const leaked of ["archived-helper title", "unpublished-helper title", "pending-helper title", "Managed fixture summary", "allowedActions", "lifecycleStatus"]) {
    assert.equal(body.includes(leaked), false, `response leaked ${leaked}: ${body}`);
  }
}

async function addUser(authStore: MemoryAuthStore, id: string, email: string, roles: Role[]) {
  authStore.addUser({
    id,
    email,
    status: "active",
    emailVerifiedAt: new Date(),
    roles,
    passwordHash: await hashPassword(PASSWORD),
  });
}

async function login(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().token as string;
}

async function loginWithMfa(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const setupSession = await login(app, email);
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: bearer(setupSession),
    payload: { password: PASSWORD },
  });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: bearer(setupSession),
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(challenge.statusCode, 200, challenge.body);
  assert.equal(challenge.json().mfaRequired, true);
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: challenge.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().user.mfaVerified, true);
  return verified.json().token as string;
}

async function createApiToken(app: ReturnType<typeof buildApp>, session: string, scopes: string[]): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: bearer(session),
    payload: { name: `managed detail ${scopes.length}`, scopes },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().token.token as string;
}

function packageInput(slug: string, version: string) {
  const manifest = parseSkillManifest({
    name: slug,
    title: `${slug} title`,
    summary: "Managed fixture summary for lifecycle detail.",
    version,
    license: "Apache-2.0",
    visibility: "public",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["workflow"],
  });
  return { manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "README.md", content: "Document setup and use." }] };
}
