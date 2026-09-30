import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { runCli, type FetchLike } from "../src/cli.js";

// Failure inventory (written before the adapter): share must use a server-owned,
// completed run and its confirmed digest; it must never create execution events,
// accept a caller's report or elevate local-report provenance. Summary disclosure
// must exclude findings, selected evidence must remain explicit, and replay keys
// must bind the full proposal list and disclosure. Scope, ownership, plan/current
// policy and exact destination bytes remain API decisions. The real HTTP API
// creates and validates fixture lifecycle records; these are synthetic local
// reports, not proof of a real model run. Existing API tests miss CLI dispatch,
// discarded fields and idempotency construction.

test("CLI shares a confirmed run with explicit disclosure, multiple proposals and stable replay", async (t) => {
  const f = await fixture(t);
  const run = await f.completeRun();
  const client = f.client(f.ownerToken);
  const proposals = await f.proposals(f.destinations);
  const args = ["improve", "share", "--run", run.id, "--disclosure", "selected-evidence", "--proposals-file", proposals];
  const shared = await client.ok(args);
  assert.equal(shared.created, true);
  assert.equal(shared.evidence.runId, run.id);
  assert.equal(shared.evidence.provenance, "local-report");
  assert.equal(shared.evidence.disclosure, "selected-evidence");
  assert.equal(shared.evidence.summary.findings?.[0]?.summary, "Retain the accepted headings.");
  assert.deepEqual(shared.evidence.proposals.map(({ subject, slug, version }) => ({ subject, slug, version })), f.destinations);
  const replayed = await client.ok(args);
  assert.equal(replayed.created, false);
  assert.equal(replayed.evidence.id, shared.evidence.id);
  const summary = await client.ok(["improve", "share", "--run", run.id, "--disclosure", "summary", "--proposals-file", proposals]);
  assert.notEqual(summary.evidence.id, shared.evidence.id, "disclosure must be in the replay key");
  assert.equal(summary.evidence.summary.findings, undefined);
  assert.equal(JSON.stringify(summary).includes("Retain the accepted headings."), false);
  const single = await client.ok(["improve", "share", "--run", run.id, "--disclosure", "summary", "--subject", "baseline", "--release", "share-source@1.0.0"]);
  assert.notEqual(single.evidence.id, summary.evidence.id, "the entire proposal list must be in the replay key");
  assert.equal(single.evidence.proposals.length, 1);
  const empty = await f.proposals([]);
  assert.deepEqual((await client.ok(["improve", "share", "--run", run.id, "--disclosure", "summary", "--proposals-file", empty])).evidence.proposals, []);
  assert.ok(f.cliRequests.length > 0);
  assert.ok(f.cliRequests.every((request) => request.method === "GET" || request.url.endsWith("/evidence")), "sharing must not create or alter execution records");
  for (const request of f.cliRequests.filter((request) => request.method === "POST")) {
    assert.deepEqual(Object.keys(request.body ?? {}).sort(), ["disclosure", "idempotencyKey", "proposals", "reportSha256"]);
    assert.equal(request.body?.reportSha256, run.reportSha256);
  }
});

test("CLI sharing preserves ownership, token scopes, completion and plan/current-policy restrictions", async (t) => {
  const f = await fixture(t);
  const complete = await f.completeRun();
  const incomplete = await f.completeRun({ complete: false });
  const summaryOnly = await f.completeRun({ disclosure: "summary" });
  const args = (id: string, disclosure = "summary") => ["improve", "share", "--run", id, "--disclosure", disclosure, "--subject", "baseline", "--release", "share-source@1.0.0"];
  await f.client(f.outsiderToken).fail(args(complete.id), /IMPROVEMENT_NOT_FOUND/);
  await f.client().fail(args(complete.id), /No token provided/);
  const readToken = (await f.post("/v1/auth/api-tokens", { name: "Read only", scopes: ["improvements:read"] })).token.token;
  await f.client(readToken).fail(args(complete.id), /API_TOKEN_SCOPE_REQUIRED/);
  const reportToken = (await f.post("/v1/auth/api-tokens", { name: "Report only", scopes: ["improvements:report"] })).token.token;
  await f.client(reportToken).fail(args(complete.id), /API_TOKEN_SCOPE_REQUIRED/);
  const beforeIncomplete = f.cliRequests.filter((request) => request.method === "POST").length;
  await f.client(f.ownerToken).fail(args(incomplete.id), /completed run/i);
  assert.equal(f.cliRequests.filter((request) => request.method === "POST").length, beforeIncomplete);
  await f.client(f.ownerToken).fail(args(summaryOnly.id, "selected-evidence"), /IMPROVEMENT_DISCLOSURE_NOT_ALLOWED/);
  await f.client(f.ownerToken).fail(["improve", "share", "--run", complete.id, "--disclosure", "summary", "--subject", "candidate", "--release", "share-source@1.0.0"], /IMPROVEMENT_BINDING_MISMATCH/);
  const localSource = await f.completeRun({ localSource: true });
  f.destinationPolicyMissing(true);
  await f.client(f.ownerToken).fail(args(localSource.id), /destination owner has not enabled/);
  f.destinationPolicyMissing(false);
  await f.post("/v1/improvements/policies/user/owner", { policy: { schemaVersion: 1, enabled: true, maxDisclosure: "summary" }, expectedRevisionNumber: 1 });
  await f.client(f.ownerToken).fail(args(complete.id, "selected-evidence"), /IMPROVEMENT_DISCLOSURE_NOT_ALLOWED/);
});

test("CLI sharing refuses malformed inputs and mixed sources before an HTTP request", async (t) => {
  const f = await fixture(t);
  const client = f.client(f.ownerToken);
  const base = ["improve", "share", "--run", "existing-run", "--disclosure", "summary"];
  for (const value of [
    { proposals: f.destinations, reportSha256: "a".repeat(64) },
    { proposals: [...Array(5)].map(() => f.destinations[0]) },
    { proposals: [{ ...f.destinations[0], provenance: "trusted-runner" }] },
    { proposals: [{ ...f.destinations[0], subject: "invented" }] },
    { proposals: [{ ...f.destinations[0], version: "latest" }] },
    { proposals: [{ ...f.destinations[0], slug: "../other" }] },
    { proposals: null },
  ]) {
    const file = await f.input(value);
    await client.fail([...base, "--proposals-file", file], /proposal|field|version|slug/i);
  }
  const file = await f.proposals(f.destinations);
  for (const args of [
    [...base, "--proposals-file", file, "--subject", "baseline", "--release", "share-source@1.0.0"],
    [...base, "--proposals-file", file, "--job", f.directory],
    ["improve", "share", "--disclosure", "summary", "--proposals-file", file],
    ["improve", "share", "--run", "../other", "--disclosure", "summary", "--proposals-file", file],
    ["improve", "share", "--run", "existing-run", "--disclosure", "automatic", "--proposals-file", file],
    [...base, "--subject", "baseline"],
  ]) await client.fail(args, /requires|required|choose|invalid|cannot|disclosure/i);
  assert.deepEqual(f.cliRequests, []);
});

test("CLI checks readback identity and the API rejects a corrupted report digest", async (t) => {
  const f = await fixture(t);
  const run = await f.completeRun();
  const args = ["improve", "share", "--run", run.id, "--disclosure", "summary", "--subject", "baseline", "--release", "share-source@1.0.0"];
  await f.client(f.ownerToken, (body) => { body.run.id = "other-run"; }).fail(args, /identity|match/i);
  assert.equal(f.cliRequests.filter((request) => request.method === "POST").length, 0);
  await f.client(f.ownerToken, (body) => { body.run.reportSha256 = "INVALID"; }).fail(args, /digest|completed run/i);
  assert.equal(f.cliRequests.filter((request) => request.method === "POST").length, 0);
  await f.client(f.ownerToken, (body) => { body.run.reportSha256 = "0".repeat(64); }).fail(args, /IMPROVEMENT_BINDING_MISMATCH/);
});

test("CLI local-job sharing retains endpoint and completion binding and summary-only disclosure", async (t) => {
  const f = await fixture(t);
  const run = await f.completeRun();
  const job = await f.localJob(run);
  const client = f.client(f.ownerToken);
  const file = await f.proposals(f.destinations);
  const base = ["improve", "share", "--job", job, "--proposals-file", file];
  await client.fail([...base, "--disclosure", "selected-evidence"], /summary evidence only/i);
  assert.deepEqual(f.cliRequests, []);
  const shared = await client.ok([...base, "--disclosure", "summary"]);
  assert.equal(shared.evidence.provenance, "local-report");
  assert.equal(shared.evidence.summary.findings, undefined);
  assert.equal(shared.evidence.proposals.length, 2);
  const legacy = await client.ok(["improve", "share", "--job", job, "--disclosure", "summary", "--subject", "baseline", "--release", "share-source@1.0.0"]);
  assert.equal(legacy.evidence.proposals.length, 1);
  assert.ok(f.cliRequests.every((request) => request.method === "POST" && request.url.endsWith("/evidence")), "local jobs retain the completion-file sharing path");
  const requestCount = f.cliRequests.length;
  const otherEndpointJob = await f.localJob(run, { apiUrl: "http://localhost:1" });
  await client.fail(["improve", "share", "--job", otherEndpointJob, "--disclosure", "summary", "--proposals-file", file], /original registry endpoint/i);
  await writeFile(path.join(job, "registry-run.json"), JSON.stringify({ runId: run.id, planDigest: "0".repeat(64), reportSha256: run.reportSha256 }));
  await client.fail([...base, "--disclosure", "summary"], /confirmed registry completion/i);
  assert.equal(f.cliRequests.length, requestCount);
});

interface RunView { id: string; planId: string; planSha256: string; reportSha256: string; state: string }
interface ApiResponse {
  created: boolean;
  profile: { latest: { id: string } };
  plan: { id: string; planSha256: string };
  run: RunView;
  token: { token: string };
  evidence: { id: string; runId: string; provenance: string; disclosure: string; summary: { findings?: Array<{ summary: string }> }; proposals: Array<{ subject: string; slug: string; version: string }> };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-improvement-share-"));
  const authStore = new MemoryAuthStore("closed");
  const password = "correct horse battery staple";
  const passwordHash = await hashPassword(password);
  for (const id of ["owner", "outsider"]) authStore.addUser({ id, email: `${id}@example.com`, name: id, roles: ["author"], status: "active", emailVerifiedAt: new Date(), passwordHash });
  const submissions = new SubmissionService(new MemorySubmissionStore());
  async function release(slug: string, version: string) {
    const manifest = parseSkillManifest({ name: slug, title: slug, summary: "CLI sharing fixture", version, license: "Apache-2.0", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }], tags: [] });
    const submission = await submissions.createSubmission({ actor: { id: "owner", roles: ["author"] }, manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: `Use the ${version} fixture.` }] });
    await submissions.performReviewAction({ actor: { id: "fixture-reviewer", roles: ["maintainer"] }, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await submissions.performReviewAction({ actor: { id: "fixture-reviewer", roles: ["maintainer"] }, submissionId: submission.id, action: "publish" });
    return submission;
  }
  const source = await release("share-source", "1.0.0");
  const candidate = await release("share-source", "1.1.0");
  const reviewer = await release("share-reviewer", "1.0.0");
  const improvementStore = new MemoryImprovementStore();
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(authStore), submissionService: submissions,
    improvementService: new ImprovementService(improvementStore, { authStore, submissionService: submissions }) });
  const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function postAs<T = ApiResponse>(endpoint: string, token: string | undefined, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${apiUrl}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, `${endpoint}: ${JSON.stringify(result)}`); return result as T;
  }
  const ownerToken = (await postAs<{ token: string }>("/v1/auth/login", undefined, { email: "owner@example.com", password })).token;
  const outsiderToken = (await postAs<{ token: string }>("/v1/auth/login", undefined, { email: "outsider@example.com", password })).token;
  const post = async (endpoint: string, body: Record<string, unknown>) => {
    if (!endpoint.startsWith("/v1/improvements/policies/")) return postAs(endpoint, ownerToken, body);
    const response = await fetch(`${apiUrl}${endpoint}`, { method: "PUT", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result as ApiResponse;
  };
  await post("/v1/improvements/policies/user/owner", { policy: { schemaVersion: 1, enabled: true, maxDisclosure: "selected-evidence" }, expectedRevisionNumber: 0 });
  const profile = await post("/v1/improvements/profiles", { owner: { type: "user", id: "owner" }, profile: {
    schemaVersion: 1, name: "Fixture runner", target: { model: { provider: "openai", id: "gpt-5.5" }, app: { id: "codex", version: "0.50.0" } }, settings: {}, objectives: ["task-success"], protectedRequirements: [],
  } });
  let sequence = 0;
  let fileNumber = 0;
  const input = async (value: unknown) => { const file = path.join(directory, `proposals-${++fileNumber}.json`); await writeFile(file, JSON.stringify(value)); return file; };
  const destinations = [{ subject: "baseline", slug: "share-source", version: "1.0.0" }, { subject: "candidate", slug: "share-source", version: "1.1.0" }];
  const cliRequests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  return {
    directory, ownerToken, outsiderToken, post, input, destinations, cliRequests, proposals: (proposals: unknown[]) => input({ proposals }),
    destinationPolicyMissing(enabled: boolean) { improvementStore.setSkillGovernance("share-source", { visibility: enabled ? "organization" : "public", teams: [], organizationIds: enabled ? ["destination-organization"] : [] }); },
    async localJob(run: RunView, options: { apiUrl?: string } = {}) {
      const response = await fetch(`${apiUrl}/v1/improvements/plans/${run.planId}`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.ok, true);
      const record = (await response.json() as { plan: unknown }).plan;
      const job = path.join(directory, `job-${++fileNumber}`);
      await mkdir(job);
      // Synthetic completion artifacts exercise the existing local handoff;
      // the real API owns the run/report. This test does not execute a model.
      const plan = { schemaVersion: 1, adapter: "claude-code-text-v1", source: { path: directory, digest: source.artifact.sha256 }, reviewers: [], model: "fixture-model", goal: "Verify sharing", targetVersion: "1.1.0", maxCalls: 10, timeoutSeconds: 120, inference: "cloud", protectedFiles: [], executable: "unused", executableDigest: "0".repeat(64), runnerPin: "launcher-only", runnerVersion: "fixture", createdAt: new Date().toISOString(), maxWallMinutes: 5, analysisOnly: false, registry: { apiUrl: options.apiUrl ?? apiUrl, planId: run.planId, planSha256: run.planSha256, record } };
      const planDigest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      await writeFile(path.join(job, "plan.json"), JSON.stringify({ plan, planDigest }));
      await writeFile(path.join(job, "registry-run.json"), JSON.stringify({ runId: run.id, planDigest, reportSha256: run.reportSha256 }));
      return job;
    },
    async completeRun(options: { complete?: boolean; disclosure?: "summary" | "selected-evidence"; localSource?: boolean } = {}) {
      const plan = (await post("/v1/improvements/plans", { idempotencyKey: `cli-sharing-plan-${++sequence}`, request: {
        schemaVersion: 1, context: { type: "user", id: "owner" }, source: options.localSource ? { kind: "local", treeSha256: source.artifact.sha256, parent: null } : { kind: "release", slug: "share-source", version: "1.0.0", artifactSha256: source.artifact.sha256 },
        reviewers: [{ slug: "share-reviewer", version: "1.0.0", artifactSha256: reviewer.artifact.sha256, roles: ["analyze", "propose"] }],
        profileRevisionId: profile.profile.latest.id, suiteRevisionId: null, goals: { objectives: ["task-success"], protectedRequirements: [] }, guidance: [],
        candidate: { maxCandidates: 1, identity: { slug: "share-source", version: "1.1.0", visibility: "public", derivativeOf: null } },
        budget: { maxModelCalls: 10, maxTokens: null, maxWallMinutes: 5 }, dataRoute: { inference: "cloud", provider: "openai", model: "gpt-5.5", contextCategories: ["subject-package", "reviewer-packages", "profile"] },
        resultSharing: options.disclosure ?? "selected-evidence", expiresInMinutes: 120,
      } })).plan;
      const run = (await post(`/v1/improvements/plans/${plan.id}/runs`, { planSha256: plan.planSha256, idempotencyKey: `cli-sharing-run-${sequence}`, runner: {
        adapter: "codex", adapterVersion: "0.50.0", coordinatorVersion: "0.1.0-beta.15", capabilities: { structuredOutput: true, workspaceIsolation: true, networkRestriction: false, tokenAccounting: false, cancellation: true, exactModelReadback: false },
      } })).run;
      if (options.complete === false) return run;
      const events = [
        { type: "stage.started", stage: "analyze" }, { type: "stage.completed", stage: "analyze", findingCount: 1 },
        { type: "stage.started", stage: "propose" },
        { type: "candidate.frozen", treeSha256: candidate.artifact.sha256, fileCount: 2, identity: { slug: "share-source", version: "1.1.0", visibility: "public", derivativeOf: null }, validation: { packageValid: true, scanBlocking: false, protectedDiffClean: true } },
        { type: "stage.completed", stage: "propose", findingCount: 0 },
        { type: "run.completed", report: { schemaVersion: 1, disposition: "candidate", findings: [{ id: "finding-1", reviewer: { slug: "share-reviewer", version: "1.0.0" }, severity: "medium", category: "instructions", summary: "Retain the accepted headings.", disposition: "addressed" }], configurationChanges: [], resources: { modelCalls: 2, tokens: null, wallMs: 1000, cost: "unknown" } } },
      ];
      let result = run;
      for (let i = 0; i < events.length; i += 1) result = (await post(`/v1/improvements/runs/${run.id}/events`, { planSha256: plan.planSha256, sequence: i + 1, event: events[i] })).run;
      return result;
    },
    client(token?: string, alterReadback?: (body: ApiResponse) => void) {
      const stdout: string[] = []; const stderr: string[] = [];
      const cliFetch: FetchLike = async (url, init) => {
        cliRequests.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
        const response = await fetch(url, init);
        if ((!init?.method || init.method === "GET") && alterReadback && response.ok) {
          const body = await response.json() as ApiResponse; alterReadback(body);
          return { ok: response.ok, status: response.status, headers: response.headers, text: async () => JSON.stringify(body) };
        }
        return response;
      };
      async function run(args: string[]) { stdout.length = 0; stderr.length = 0; return runCli([...args, "--api-url", apiUrl, "--json"], { env: { HOME: directory, ...(token ? { MYSKILLS_TOKEN: token } : {}) }, fetch: cliFetch, io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } }); }
      return {
        async ok(args: string[]) { assert.equal(await run(args), 0, stderr.join("\n")); return JSON.parse(stdout.join("\n")) as ApiResponse; },
        async fail(args: string[], pattern: RegExp) { assert.notEqual(await run(args), 0); assert.match(stderr.join("\n"), pattern); },
      };
    },
  };
}
