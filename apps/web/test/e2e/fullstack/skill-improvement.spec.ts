import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalizeJson } from "@myskills-app/core";

// Real HTTP, Postgres, artifact storage, CLI filesystem and rendered browser.
// The deterministic child executable verifies integration, not model quality.
test("registry plan, local CLI evaluation, exact candidate publication and evidence acceptance", async ({ page }, info) => {
  test.setTimeout(180_000);
  const baseUrl = process.env.MYSKILLS_E2E_BASE_URL!;
  const token = process.env.MYSKILLS_ACCEPTANCE_OWNER_TOKEN!;
  if (!baseUrl || !token) throw new Error("Disposable full-stack environment is required.");
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-opt1-e2e-"));
  const checks: string[] = [];
  const api = async (endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${baseUrl}/api${endpoint}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    expect(response.ok, `${endpoint}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const cli = async (args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../../../cli/dist/index.js", import.meta.url)), "improve", ...args, "--json"], {
      env: { ...process.env, MYSKILLS_API_URL: `${baseUrl}/api`, MYSKILLS_TOKEN: token, MYSKILLS_CONFIG_DIR: path.join(root, "config"), MYSKILLS_TOKEN_STORE: "file" },
      timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const hash = (value: unknown) => createHash("sha256").update(canonicalizeJson(value)).digest("hex");
  const suffix = randomUUID().slice(0, 8);
  const slug = `improvement-source-${suffix}`; const reviewerSlug = `improvement-reviewer-${suffix}`;
  const releaseMetadata = { releaseNotes: "Public synthetic improvement acceptance fixture.", changeKind: "feature", requiresUserAction: false, compatibility: { minimumMyskillsVersion: "0.1.0-beta.4", minimumAdapterContractVersion: 1, minimumSourceVersion: "0.0.1" } };
  async function publish(files: { path: string; content: string }[]) {
    const manifest = JSON.parse(files.find((f) => f.path === "skill.json")!.content);
    const submission = (await api("/v1/submissions", { manifest, files, release: releaseMetadata })).submission;
    const preview = await fetch(`${baseUrl}/api/v1/review/submissions/${submission.id}/bundle?platform=codex`, { headers: { authorization: `Bearer ${token}` } });
    expect(preview.ok).toBe(true);
    const artifactSha256 = createHash("sha256").update(await preview.text()).digest("hex");
    await api(`/v1/review/submissions/${submission.id}/actions`, { action: "approve", artifactSha256 });
    await api(`/v1/review/submissions/${submission.id}/actions`, { action: "publish" });
    return { slug: manifest.name, version: manifest.version, artifactSha256 };
  }
  const packageFiles = (name: string) => [
    { path: "skill.json", content: JSON.stringify({ name, title: "Improvement acceptance fixture", summary: "Public synthetic skill for integration checks.", version: "0.1.0", license: "MIT", visibility: "public", platforms: [{ name: "codex", install_target: ".agents/skills" }] }) },
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: Summarize release notes when asked.\n---\nPreserve approval requirements.\n` },
  ];
  try {
    const source = await publish(packageFiles(slug)); const reviewer = await publish(packageFiles(reviewerSlug));
    const user = (await api("/v1/me")).user;
    const declaration = { schemaVersion: 1, intent: "targeted", targets: [{ id: "text-contract", models: [{ provider: "openai", id: "fixture-model" }], apps: [{ id: "codex" }] }], objectives: ["task-success"], limitations: ["Synthetic text-contract integration fixture. No model quality claim."] };
    const revision = (await api(`/v1/improvements/releases/${slug}/0.1.0/declarations`, { declaration, expectedRevisionNumber: 0 })).revision;
    await api(`/v1/improvements/releases/${slug}/0.1.0/declarations/${revision.id}/review`, { decision: "approve", artifactSha256: source.artifactSha256, declarationSha256: revision.declarationSha256 });
    await page.goto(`/skills/${slug}`);
    const panel = page.getByRole("region", { name: "Skill improvement" });
    await expect(panel.getByText("The author declared these targets. A declaration is not evaluation evidence.")).toBeVisible();
    await expect(panel.getByText("No accepted evaluation evidence.")).toBeVisible();
    checks.push("approved attestation renders independently of evaluation evidence");
    const profile = (await api("/v1/improvements/profiles", { owner: { type: "user", id: user.id }, profile: { schemaVersion: 1, name: "Text fixture", target: { model: { provider: "openai", id: "fixture-model" }, app: { id: "codex", version: "0.154.0" }, environment: { os: [], requiredCapabilities: [], network: "optional" } }, settings: {}, objectives: ["task-success"], protectedRequirements: [] } })).profile;
    const suite = { schemaVersion: 1, cases: [
      { id: "development", partition: "development", input: "Summarize a change.", includes: ["ACCEPT"], excludes: ["publish"] },
      { id: "holdout", partition: "holdout", input: "Summarize an unfamiliar change.", includes: ["ACCEPT"], excludes: ["publish"] },
      { id: "protected", partition: "protected", input: "Preserve authority.", includes: ["ACCEPT"], excludes: ["publish"] },
    ] };
    const suiteDocument = (await api("/v1/improvements/suites", { owner: { type: "user", id: user.id }, suite: { schemaVersion: 1, name: "Text contract fixture", contentSha256: hash(suite), rubricSha256: hash(suite.cases.map(({ includes, excludes }) => ({ includes, excludes }))), caseCount: 3, protectedCaseCount: 1, holdoutCaseCount: 1, graders: ["deterministic"], repetitions: 1 } })).suite;
    const prepared = (await api("/v1/improvements/plans", { idempotencyKey: `plan-${suffix}`, request: {
      schemaVersion: 1, context: { type: "user", id: user.id }, source: { kind: "release", ...source }, reviewers: [{ ...reviewer, roles: ["analyze", "propose"] }],
      profileRevisionId: profile.latest.id, suiteRevisionId: suiteDocument.latest.id,
      goals: { objectives: ["task-success"], protectedRequirements: ["Preserve approval requirements."] }, guidance: [], candidate: { maxCandidates: 1, identity: { slug, version: "0.2.0", visibility: "public", derivativeOf: null } },
      budget: { maxModelCalls: 7, maxTokens: null, maxWallMinutes: 5 }, dataRoute: { inference: "cloud", provider: "openai", model: "fixture-model", contextCategories: ["subject-package", "reviewer-packages", "profile", "suite"] }, resultSharing: "summary", expiresInMinutes: 120,
    } })).plan;
    const executable = path.join(root, "runner-fixture");
    await writeFile(executable, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0);}let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const p=JSON.parse(text);const result=p.stage==='analyze'?{disposition:'candidate',findings:[{id:'clarity',severity:'info',summary:'Clarify the output contract.'}],rationale:'Add explicit output instructions.',changes:[{path:'SKILL.md',content:p.skill.find(f=>f.path==='SKILL.md').content+'IMPROVED: Return ACCEPT.\\n'}]}:{response:p.input==='Preserve authority.'||p.skill.some(f=>f.content.includes('IMPROVED'))?'ACCEPT':'UNCLEAR'};fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(result));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));console.log(JSON.stringify({type:'turn.completed'}));});\n`, { mode: 0o700 });
    const suiteFile = path.join(root, "suite.json"); await writeFile(suiteFile, JSON.stringify(suite));
    const job = path.join(root, "job");
    const local = await cli(["fetch", "--plan", prepared.id, "--output", job, "--suite", suiteFile, "--codex-path", executable]);
    const report = await cli(["run", "--job", job, "--accept-plan", local.planDigest, "--allow-cloud"]);
    expect(report.state).toBe("completed"); expect(report.registrySync).toBe("confirmed"); expect(report.calls).toBe(7);
    expect(report.evaluation.outcome).toBe("improved"); expect(report.modelVerification).toBe("unobserved");
    checks.push("registered CLI evaluates the exact pinned baseline and frozen candidate with holdout gain");
    const draft = path.join(root, "draft"); await cli(["export", "--job", job, "--output", draft]);
    const candidate = await publish(await Promise.all((await readdir(draft)).map(async (name) => ({ path: name, content: await readFile(path.join(draft, name), "utf8") }))));
    expect(candidate.artifactSha256).toBe(report.candidateDigest);
    const shared = await cli(["share", "--job", job, "--disclosure", "summary", "--subject", "candidate", "--release", `${slug}@0.2.0`]);
    const evidence = shared.evidence;
    await api(`/v1/improvements/evidence/${evidence.id}/acceptances`, { slug, version: "0.2.0", subject: "candidate", evidenceSha256: evidence.evidenceSha256, decision: "accept" });
    const compatibility = (await api(`/v1/improvements/releases/${slug}/0.2.0/compatibility`)).compatibility;
    expect(compatibility.evidence[0].claim).toBe("locally-reported-improvement");
    expect(compatibility.evidence[0].provenance).toBe("local-report");
    await page.goto(`/skills/${slug}`);
    await expect(panel.getByText(/locally reported improvement · local-report · current/)).toBeVisible();
    checks.push("published candidate bytes match evaluation and accepted evidence stays local-report");
    await page.screenshot({ path: info.outputPath("improvement-evidence-accepted.png"), fullPage: true });
    await info.attach("improvement-acceptance", { body: JSON.stringify({ schemaVersion: 1, runner: "deterministic-executable-fixture", checks, planSha256: prepared.planSha256, candidateSha256: candidate.artifactSha256, evidenceSha256: evidence.evidenceSha256 }), contentType: "application/json" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
