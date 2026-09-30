import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "@myskills-app/auth";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { buildApp } from "../../api/src/app.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { ImprovementService } from "../../api/src/improvements/service.js";
import { MemoryImprovementStore } from "../../api/src/improvements/memory-store.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../api/src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../api/src/submissions/service.js";
import { runCli } from "../src/cli.js";

// Failure inventory, written before implementation:
// - Saved-plan inspection must preserve the plan and runs, even for expired
//   plans and targets the local runner cannot execute; a read must not create a job.
// - Missing credentials, another user's plan and insufficient scopes must not
//   expose a saved plan. Existing API journeys do not test CLI routing/output.
// - Public compatibility must work without login, while private compatibility
//   remains hidden and supplied credentials still receive scope enforcement.
// These journeys use the actual HTTP listener, API authorization and stores.

test("CLI show-plan inspects complete saved plans and runs without local execution", async (t) => {
  const f = await fixture(t);
  const owner = f.client(f.ownerToken);
  const outsider = f.client(f.outsiderToken);
  const profile = await f.post("/v1/improvements/profiles", f.ownerToken, {
    owner: { type: "user", id: "owner" },
    profile: {
      schemaVersion: 1, name: "Inspection-only Codex target",
      target: { model: { provider: "openai", id: "gpt-5.5" }, app: { id: "codex", version: "0.50.0" } },
      settings: { reasoningEffort: "high" }, objectives: ["task-success"], protectedRequirements: [],
    },
  });
  const prepared = await f.post("/v1/improvements/plans", f.ownerToken, {
    idempotencyKey: "cli-inspection-plan",
    request: {
      schemaVersion: 1, context: { type: "user", id: "owner" },
      source: { kind: "release", slug: "readable-source", version: "1.0.0", artifactSha256: f.source.artifact.sha256 },
      reviewers: [{ slug: "readable-reviewer", version: "1.0.0", artifactSha256: f.reviewer.artifact.sha256, roles: ["analyze"] }],
      profileRevisionId: profile.profile.latest.id, suiteRevisionId: null,
      goals: { objectives: ["task-success"], protectedRequirements: [] }, guidance: [],
      candidate: { maxCandidates: 1, identity: null },
      budget: { maxModelCalls: 10, maxTokens: null, maxWallMinutes: 5 },
      dataRoute: { inference: "cloud", provider: "openai", model: "gpt-5.5", contextCategories: ["subject-package", "reviewer-packages", "profile"] },
      resultSharing: "summary", expiresInMinutes: 5,
    },
  });
  const plan = prepared.plan;
  const started = await f.post(`/v1/improvements/plans/${plan.id}/runs`, f.ownerToken, {
    planSha256: plan.planSha256, idempotencyKey: "cli-inspection-run",
    runner: { adapter: "codex", adapterVersion: "0.50.0", coordinatorVersion: "0.1.0-beta.15", capabilities: {
      structuredOutput: true, workspaceIsolation: true, networkRestriction: false,
      tokenAccounting: false, cancellation: true, exactModelReadback: false,
    } },
  });
  const before = await readdir(f.directory);
  const inspected = await owner.ok(["improve", "show-plan", "--id", plan.id]);
  assert.equal(inspected.plan.id, plan.id);
  assert.equal(inspected.plan.planSha256, plan.planSha256);
  assert.equal(inspected.plan.plan.profile.target.app.id, "codex");
  assert.equal(inspected.plan.plan.profile.settings.reasoningEffort, "high");
  assert.equal(inspected.runs[0].id, started.run.id);
  assert.equal(inspected.runs[0].state, "running");
  f.advanceClock(6 * 60_000);
  const expired = await owner.ok(["improve", "show-plan", "--id", plan.id]);
  assert.equal(expired.plan.status, "expired");
  assert.equal(expired.runs[0].state, "expired");
  assert.deepEqual(await readdir(f.directory), before, "inspection must not write a local job");
  await outsider.fail(["improve", "show-plan", "--id", plan.id], /IMPROVEMENT_NOT_FOUND/);
  await f.client().fail(["improve", "show-plan", "--id", plan.id], /No token provided/);
  await owner.fail(["improve", "show-plan", "--id", "../private"], /Invalid.*identifier/);
  await owner.fail(["improve", "show-plan", "--id", plan.id, "--output", f.directory], /Unsupported.*output/);
  const scoped = await f.post("/v1/auth/api-tokens", f.ownerToken, { name: "Profile only", scopes: ["profile:read"] });
  await f.client(scoped.token.token).fail(["improve", "show-plan", "--id", plan.id], /API_TOKEN_SCOPE_REQUIRED/);
});

test("CLI compatibility permits public anonymous reads and preserves private visibility and token scopes", async (t) => {
  const f = await fixture(t);
  const anonymous = f.client();
  const publicResult = await anonymous.ok(["improve", "compatibility", "--release", "readable-source@1.0.0"]);
  assert.equal(publicResult.compatibility.release.slug, "readable-source");
  assert.equal(publicResult.compatibility.declaration.status, "unspecified");
  assert.equal(publicResult.compatibility.manage, undefined);
  await anonymous.fail(["improve", "compatibility", "--release", "private-source@1.0.0"], /RELEASE_NOT_FOUND/);
  const privateResult = await f.client(f.ownerToken).ok(["improve", "compatibility", "--release", "private-source@1.0.0"]);
  assert.equal(privateResult.compatibility.release.slug, "private-source");
  assert.ok(privateResult.compatibility.manage);
  const scoped = await f.post("/v1/auth/api-tokens", f.ownerToken, { name: "Skills only", scopes: ["skills:read"] });
  await f.client(scoped.token.token).fail(["improve", "compatibility", "--release", "readable-source@1.0.0"], /API_TOKEN_SCOPE_REQUIRED/);
});

interface ImprovementResponse {
  profile: { latest: { id: string } };
  plan: { id: string; planSha256: string; status: string; plan: { profile: { target: { app: { id: string } }; settings: { reasoningEffort: string } } } };
  run: { id: string; state: string };
  runs: Array<{ id: string; state: string }>;
  compatibility: { release: { slug: string }; declaration: { status: string }; manage?: unknown };
  token: { token: string };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-improvement-read-"));
  const authStore = new MemoryAuthStore("closed");
  const password = "correct horse battery staple";
  const passwordHash = await hashPassword(password);
  for (const id of ["owner", "outsider"]) {
    authStore.addUser({ id, email: `${id}@example.com`, name: id, roles: ["author"], status: "active", emailVerifiedAt: new Date(), passwordHash });
  }
  const submissions = new SubmissionService(new MemorySubmissionStore());
  const release = async (slug: string, visibility: "public" | "private") => {
    const manifest = parseSkillManifest({ name: slug, title: slug, summary: "CLI inspection fixture", version: "1.0.0", license: "Apache-2.0", visibility, platforms: [{ name: "codex", install_target: "codex-skill" }], tags: [] });
    const submission = await submissions.createSubmission({ actor: { id: "owner", roles: ["author"] }, manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: "Inspect the fixture." }] });
    await submissions.performReviewAction({ actor: { id: "fixture-reviewer", roles: ["maintainer"] }, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await submissions.performReviewAction({ actor: { id: "fixture-reviewer", roles: ["maintainer"] }, submissionId: submission.id, action: "publish" });
    return submission;
  };
  const source = await release("readable-source", "public");
  const reviewer = await release("readable-reviewer", "public");
  await release("private-source", "private");
  let now = Date.now();
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]), authService: new AuthService(authStore), submissionService: submissions,
    improvementService: new ImprovementService(new MemoryImprovementStore(), { authStore, submissionService: submissions }, { now: () => new Date(now) }),
  });
  const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async <T = ImprovementResponse>(endpoint: string, token: string | undefined, body: Record<string, unknown>): Promise<T> => {
    const result = await fetch(`${apiUrl}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const value = await result.json();
    assert.ok(result.ok, `${endpoint}: ${JSON.stringify(value)}`);
    return value as T;
  };
  const ownerToken = (await post<{ token: string }>("/v1/auth/login", undefined, { email: "owner@example.com", password })).token;
  const outsiderToken = (await post<{ token: string }>("/v1/auth/login", undefined, { email: "outsider@example.com", password })).token;
  return {
    directory, post, source, reviewer, ownerToken, outsiderToken, advanceClock: (milliseconds: number) => { now += milliseconds; },
    client(token?: string) {
      const stdout: string[] = []; const stderr: string[] = [];
      const run = async (args: string[]) => {
        stdout.length = 0; stderr.length = 0;
        return runCli([...args, "--api-url", apiUrl, "--json"], {
          env: { HOME: directory, ...(token ? { MYSKILLS_TOKEN: token } : {}) }, fetch,
          io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
        });
      };
      return {
        async ok(args: string[]): Promise<ImprovementResponse> { assert.equal(await run(args), 0, stderr.join("\n")); return JSON.parse(stdout.join("\n")) as ImprovementResponse; },
        async fail(args: string[], pattern: RegExp) { assert.notEqual(await run(args), 0); assert.match(stderr.join("\n"), pattern); },
      };
    },
  };
}
