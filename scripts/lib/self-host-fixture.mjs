// Mounted into the real candidate API/OPS images by the internal rehearsal.
// Fixture credentials, tokens, MFA seeds and package contents stay in /proof.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [mode, configPath] = process.argv.slice(2);
const data = JSON.parse(readFileSync(configPath, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = () => writeFileSync(configPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });

if (mode === "seed-nonowner") {
  // Only a generated disposable Compose database is supplied by the driver.
  // Use the existing store; no mail provider or new account ingress is needed.
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.hostname, "postgres"); assert.equal(database.pathname, "/myskills");
  assert.ok(["fresh", "legacy"].includes(data.fixtureName));
  const { hashPassword } = await import("/app/packages/auth/dist/index.js");
  const { createDb, createPgPool } = await import("/app/apps/api/dist/db/client.js");
  const { PostgresAuthStore } = await import("/app/apps/api/dist/auth/postgres-auth-store.js");
  const pool = createPgPool(process.env.DATABASE_URL);
  try {
    const store = new PostgresAuthStore(createDb(pool));
    data.nonowner = { email: `nonowner-${randomBytes(8).toString("hex")}@operator.test`, password: randomBytes(32).toString("hex") };
    const result = await store.createUserWithPassword({ ...data.nonowner, name: "Disposable HOST non-owner", passwordHash: await hashPassword(data.nonowner.password) });
    assert.equal(result.created, true); assert.deepEqual(result.user.roles, ["user"]);
    data.nonowner.id = result.user.id;
    assert.ok(await store.updateUserStatus({ userId: result.user.id, status: "active", emailVerifiedAt: new Date() }));
    save();
  } finally { await pool.end(); }
} else if (mode === "bucket") {
  const { S3Client, CreateBucketCommand } = require("/app/node_modules/@aws-sdk/client-s3");
  const client = new S3Client({ endpoint: data.MYSKILLS_RECOVERY_BACKUP_S3_ENDPOINT, region: "local", forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: data.MYSKILLS_RECOVERY_BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: data.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY } });
  try {
    let made = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await client.send(new CreateBucketCommand({ Bucket: data.MYSKILLS_RECOVERY_BACKUP_S3_BUCKET }), { abortSignal: AbortSignal.timeout(3000) }); made = true; break; }
      catch { await new Promise((done) => setTimeout(done, 500)); }
    }
    assert.ok(made, "isolated backup bucket creation failed");
  } finally { client.destroy(); }
} else {
  const { generateTotpCode } = await import("/app/packages/auth/dist/index.js");
  let token;
  async function api(path, body, { anonymous = false, status = 200, raw = false, method = body ? "POST" : "GET" } = {}) {
    const response = await fetch(`${data.api}${path}`, { method, headers: {
      ...(token && !anonymous ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, status, `HTTP ${path} expected ${status}; returned ${response.status}`);
    return response.status === 204 ? null : raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  const source = await api("/version.json");
  assert.deepEqual(source, { version: data.expectedSource.version, revision: data.expectedSource.commit });
  if (data.web) {
    const web = await fetch(`${data.web}/version.json`, { signal: AbortSignal.timeout(10_000) });
    assert.ok(web.ok); assert.deepEqual(await web.json(), source);
  }
  const capability = await api("/v1/capabilities");
  if (mode === "create") data.instanceId = capability.instanceId;
  else assert.equal(capability.instanceId, data.instanceId);
  assert.match(data.instanceId, /^[a-f0-9-]{36}$/);
  const credentials = { email: data.SEED_OWNER_EMAIL, password: data.SEED_OWNER_PASSWORD };
  let session = await api("/v1/auth/login", credentials);
  if (mode === "create") {
    token = session.token; assert.ok(token);
    const enrollment = await api("/v1/auth/mfa/totp/enroll", { password: credentials.password }, { status: 201 });
    data.mfaSecret = enrollment.enrollment.secret;
    const enrolledAt = Date.now(); data.enrolledTotpCounter = Math.floor(enrolledAt / 30_000);
    const confirmed = await api("/v1/auth/mfa/totp/confirm", { factorId: enrollment.enrollment.factorId, code: generateTotpCode(data.mfaSecret, { now: enrolledAt }) });
    data.recoveryCodes = confirmed.mfa.recoveryCodes;
    session = await api("/v1/auth/login", credentials, { anonymous: true });
  }
  assert.ok(session.challengeToken, "original account must require MFA");
  // Recovery codes exercise a separate path. A restored runtime must also
  // decrypt the original encrypted TOTP factor and accept a fresh real code.
  if (mode !== "create") {
    const until = Date.now() + 35_000;
    while (Math.floor(Date.now() / 30_000) <= data.enrolledTotpCounter && Date.now() < until) await new Promise((done) => setTimeout(done, 250));
    assert.ok(Math.floor(Date.now() / 30_000) > data.enrolledTotpCounter);
    const totp = await api("/v1/auth/mfa/verify", { challengeToken: session.challengeToken, code: generateTotpCode(data.mfaSecret) }, { anonymous: true });
    assert.equal(totp.user.id, data.ownerId); assert.equal(totp.user.mfaVerified, true); assert.ok(totp.token);
    session = await api("/v1/auth/login", credentials, { anonymous: true });
    assert.ok(session.challengeToken);
  }
  const verified = await api("/v1/auth/mfa/verify", { challengeToken: session.challengeToken, recoveryCode: data.recoveryCodes.shift() }, { anonymous: true });
  token = verified.token; assert.ok(token); assert.equal(verified.user.mfaVerified, true);
  if (mode === "create") {
    data.ownerId = verified.user.id;
    const manifest = { name: `host-${data.fixtureName}`, title: "Disposable HOST proof", summary: "Record fixture backup and restore evidence.",
      version: "1.0.0", license: "Apache-2.0", visibility: "user", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: ["testing"] };
    const submission = await api("/v1/submissions", { manifest, files: [{ path: "skill.json", content: `${JSON.stringify(manifest)}\n` },
      { path: "SKILL.md", content: "---\nname: host-proof\ndescription: Record the supplied fixture checks.\n---\n\nReport only observed fixture outcomes.\n" }] }, { status: 202 });
    data.submissionId = submission.submission.id;
    const architecture = await api("/v1/architectures", { name: `HOST ${data.fixtureName}`, description: "Persist an original fixture architecture through recovery.", patternId: "flat" }, { status: 201 });
    data.architectureId = architecture.architecture.id;
    const bundle = await api(`/v1/submissions/${data.submissionId}/bundle`, undefined, { raw: true });
    data.packageSha256 = hash(bundle); data.packageBytes = bundle.length;
    if (capability.capabilities?.drafts) {
      const fork = await api("/v1/drafts", { title: "Persisted HOST author draft", source: { kind: "submission", submissionId: data.submissionId } }, { status: 201 });
      data.draftId = fork.draft.id; data.draftFilesSha256 = hash(JSON.stringify(fork.draft.files));
      await api(`/v1/drafts/${data.draftId}/validate`, { expectedRevision: fork.draft.revision });
    }
    save();
  } else {
    assert.equal(verified.user.id, data.ownerId);
    if (data.draftId) {
      const restored = await api(`/v1/drafts/${data.draftId}`);
      assert.equal(hash(JSON.stringify(restored.draft.files)), data.draftFilesSha256);
      await api(`/v1/drafts/${data.draftId}`, undefined, { anonymous: true, status: 401 });
    }
    await api(`/v1/architectures/${data.architectureId}`);
    const bundle = await api(`/v1/submissions/${data.submissionId}/bundle`, undefined, { raw: true });
    assert.equal(hash(bundle), data.packageSha256); assert.equal(bundle.length, data.packageBytes);
  }
  await api(`/v1/submissions/${data.submissionId}/bundle`, undefined, { anonymous: true, status: 401 });
  const ownerToken = token;
  if (mode === "create") {
    data.revokedSessionToken = token;
    await api("/v1/auth/logout", undefined, { method: "POST", status: 204 });
  }
  token = data.revokedSessionToken;
  assert.ok(token); await api(`/v1/submissions/${data.submissionId}/bundle`, undefined, { status: 401 });
  const nonowner = await api("/v1/auth/login", { email: data.nonowner.email, password: data.nonowner.password }, { anonymous: true });
  assert.ok(nonowner.token); assert.equal(nonowner.user.id, data.nonowner.id); assert.deepEqual(nonowner.user.roles, ["user"]);
  token = nonowner.token;
  await api(`/v1/submissions/${data.submissionId}/bundle`, undefined, { status: 404 });
  token = ownerToken;
  if (mode === "create") {
    session = await api("/v1/auth/login", credentials, { anonymous: true });
    const resumed = await api("/v1/auth/mfa/verify", { challengeToken: session.challengeToken, recoveryCode: data.recoveryCodes.shift() }, { anonymous: true });
    token = resumed.token; assert.ok(token);
  }
  data.authProof = { totp: mode === "create" ? "enrollment-confirmed" : "original-factor-decrypted-and-verified",
    recoveryCode: "verified", nonownerPrivateArtifact: "denied", revokedSession: "denied" };
  // Read the feedback through the real API; do not fabricate scan/eval evidence.
  let submission = await api(`/v1/submissions/${data.submissionId}`);
  if (mode === "create") {
    const until = Date.now() + 60_000;
    while (Date.now() < until && (!(submission.submission.scanRuns ?? submission.submission.feedback?.scanRuns)?.length
      || (submission.submission.scanRuns ?? submission.submission.feedback.scanRuns).some((run) => !run.completedAt))) {
      await new Promise((done) => setTimeout(done, 500)); submission = await api(`/v1/submissions/${data.submissionId}`);
    }
    assert.ok((submission.submission.scanRuns ?? submission.submission.feedback?.scanRuns)?.length, "fixture requires durable scan evidence");
  }
  const scans = submission.submission.scanRuns ?? submission.submission.feedback?.scanRuns ?? [];
  if (mode === "create") data.originalScanCount = scans.length;
  else assert.ok(scans.length >= data.originalScanCount, "original scan rows must survive the transition");
  data.persistedFeedback = { securityStatus: submission.submission?.securityStatus ?? null, scanCount: scans.length };
  // Added draft routes are exercised only when present in the exact integrated
  // source; current baseline has no draft or eval creation surface.
  if (mode === "composed-storage") data.composedProof = await composedStorageProof(api, token, data);
  else if (data.composedProof) {
    const persisted = await api(`/v1/architecture-artifacts/${data.composedProof.runId}`);
    assert.equal(persisted.intent.treeDigest, data.composedProof.treeDigest);
    assert.equal(persisted.run.state, "succeeded");
  }
  // Only real API-created records count. A legacy baseline cannot prove an
  // evaluation survived restore when the capability did not exist at backup.
  if (mode === "create" && capability.capabilities?.evaluations) {
    const { defaultPackageEvaluationSuite } = await import("/app/packages/skill-package/dist/index.js");
    const { suite } = await api("/v1/improvements/suites", { owner: { type: "user", id: data.ownerId }, suite: defaultPackageEvaluationSuite() }, { status: 201 });
    const current = submission.submission;
    const slug = current.slug, version = current.version;
    await api(`/v1/review/submissions/${data.submissionId}/actions`, { action: "approve", artifactSha256: current.artifact.sha256 });
    await api(`/v1/review/submissions/${data.submissionId}/actions`, { action: "publish", artifactSha256: current.artifact.sha256 });
    await api(`/v1/skills/${slug}/sharing`, { visibility: "public", userEmails: [], teamIds: [], organizationIds: [] }, { method: "PUT" });
    const { run } = await api(`/v1/evaluations/releases/${slug}/${version}/runs`, {
      artifactSha256: current.artifact.sha256, suiteRevisionId: suite.latest.id, platform: "codex", idempotencyKey: `host-${data.fixtureName}-evaluation`, disclosure: "public-summary",
    }, { status: 201 });
    assert.equal(run.versionId, data.submissionId); assert.equal(run.result.artifactSha256, current.artifact.sha256);
    assert.equal(run.result.suiteSha256, suite.latest.bodySha256); assert.equal(run.result.provenance, "api-owned");
    assert.equal(run.suiteRevisionId, suite.latest.id);
    assert.equal(run.result.runner.id, "package-static"); assert.equal(run.result.runner.version, "1"); assert.equal(run.result.totals.skipped, 1);
    const { runs } = await api(`/v1/evaluations/releases/${slug}/${version}/summary`);
    const summary = runs.find(value => value.id === run.id); assert.ok(summary); assert.equal(summary.summary.assertions, undefined);
    // Public projection stays bounded. The private /proof fixture separately
    // retains the exact suite binding needed to verify authenticated restore.
    data.evaluationProof = { slug, version, record: summary, suiteBinding: { revisionId: run.suiteRevisionId, sha256: run.result.suiteSha256 } };
  } else if (data.evaluationProof) {
    assert.equal(capability.capabilities?.evaluations, true);
    const { slug, version, record, suiteBinding } = data.evaluationProof;
    assert.ok(suiteBinding?.revisionId && /^[a-f0-9]{64}$/.test(suiteBinding.sha256), "private original suite binding is required");
    const { runs } = await api(`/v1/evaluations/releases/${slug}/${version}/summary`);
    assert.deepEqual(runs.find(value => value.id === record.id), record, "exact evaluation bindings and summary must survive restore");
    const { runs: details } = await api(`/v1/evaluations/releases/${slug}/${version}/runs`);
    const restored = details.find(value => value.id === record.id); assert.ok(restored);
    assert.equal(restored.versionId, record.versionId); assert.equal(restored.result.artifactSha256, record.summary.artifactSha256);
    assert.equal(restored.suiteRevisionId, suiteBinding.revisionId); assert.equal(restored.result.suiteSha256, suiteBinding.sha256);
    assert.deepEqual(restored.result.totals, record.summary.totals);
  }
  data.persistedBoundaries = { draft: data.draftId ? "tested" : "not-available-on-source", evaluation: data.evaluationProof ? (mode === "create" ? "created-before-backup" : "restored-exact-summary") : "not-exercised", architecture: "tested", submission: "tested", scanFeedback: "read" };
  save();
}
console.log(JSON.stringify({ passed: true, fixture: mode }));


async function composedStorageProof(api, token, data) {
  const core = await import("/app/packages/core/dist/index.js");
  const { hashSessionToken } = await import("/app/packages/auth/dist/index.js");
  const { createDb, createPgPool } = await import("/app/apps/api/dist/db/client.js");
  const { PostgresArchitectureSyncStore } = await import("/app/apps/api/dist/architecture-sync/postgres-store.js");
  const { ArchitectureArtifactService } = await import("/app/apps/api/dist/architecture-sync/artifact-service.js");
  const { PostgresArchitectureStore } = await import("/app/apps/api/dist/architectures/postgres-store.js");
  const { PostgresArchitectureTargetStore } = await import("/app/apps/api/dist/targets/postgres-target-store.js");
  const { PostgresSkillRepository } = await import("/app/apps/api/dist/repositories/postgres-skill-repository.js");
  const { PostgresSubmissionStore } = await import("/app/apps/api/dist/submissions/postgres-submission-store.js");
  const { SubmissionService } = await import("/app/apps/api/dist/submissions/service.js");
  const { S3ArtifactObjectStorage } = await import("/app/apps/api/dist/artifacts/storage.js");
  const { S3Client } = require("/app/node_modules/@aws-sdk/client-s3");
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.hostname, "postgres"); assert.equal(database.pathname, "/myskills"); assert.equal(data.fixtureName, "fresh");
  const pool = createPgPool(database.href), db = createDb(pool);
  const forbiddenClient = new S3Client({ endpoint: "http://minio:9000", region: "local", forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: "fixture-denied-key", secretAccessKey: "fixture-denied-secret" } });
  try {
    const pins = [];
    for (const [index, version] of [[0, "2.0.0"], [1, "1.0.0"]]) {
      const slug = `composed-${data.fixtureName}-${index}`;
      const manifest = { name: slug, title: slug, summary: "Disposable composed MinIO proof", version, license: "Apache-2.0", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: [] };
      const { submission } = await api("/v1/submissions", { manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Synthetic object-backed proof\n---\nExact ${version} instructions.\n` }, { path: "references/bytes.txt", content: `Exact asset ${version}\n` }] }, { status: 202 });
      const until = Date.now() + 60_000; let current;
      do { current = (await api(`/v1/submissions/${submission.id}`)).submission; if (current.securityStatus === "passed") break; await new Promise(resolve => setTimeout(resolve, 250)); } while (Date.now() < until);
      assert.equal(current.securityStatus, "passed");
      await api(`/v1/review/submissions/${submission.id}/actions`, { action: "approve", artifactSha256: submission.artifact.sha256 });
      await api(`/v1/review/submissions/${submission.id}/actions`, { action: "publish" });
      pins.push({ id: slug, slug, version, digest: submission.artifact.sha256, packageVisibility: "public", domainId: "proof" });
    }
    const { architecture } = await api("/v1/architectures", { name: "Composed MinIO source proof", patternId: "multi-level-router", description: "Explicit disposable fixture" }, { status: 201 });
    const spec = core.createMultiLevelRouterArchitecture({ id: architecture.id, name: architecture.name, skills: pins, profile: { id: "fixture", subject: { type: "user", id: data.ownerId } }, environment: { id: "fixture-workspace", kind: "personal" } });
    const { revision } = await api(`/v1/architectures/${architecture.id}/revisions`, { expectedCurrentRevisionId: null, message: "Exact object-backed topology", spec }, { status: 201 });
    const { target: registered } = await api("/v1/architecture-targets", { name: "Explicit disposable object-store workspace", architectureId: architecture.id, profileId: "fixture", environmentId: "fixture-workspace", adapter: { kind: "codex-workspace", version: "1.0.0", contractVersion: 2 }, capabilities: { "inventory.read": true, "health.read": true, "plan.read": true, apply: true, rollback: true, "sync.write": true } }, { status: 201 });
    const { target } = await api(`/v1/architecture-targets/${registered.id}/consent`, { decision: "grant" });
    const { observation } = await api(`/v1/architecture-targets/${target.id}/observations`, { schemaVersion: 1, id: crypto.randomUUID(), targetId: target.id, targetGeneration: target.generation, adapterDigest: core.architectureTargetAdapterDigest(target.adapter), capabilitiesDigest: core.architectureTargetCapabilitiesDigest(target.capabilities, 2), observedAt: new Date().toISOString(), skills: [], configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true } }, { status: 201 });
    const { run: review } = await api(`/v1/architecture-targets/${target.id}/plans`, { revisionId: revision.id, expectedTargetGeneration: target.generation, expectedObservationId: observation.id, expectedObservationDigest: observation.observedDigest, idempotencyKey: "minio-review" }, { status: 201 });
    await api(`/v1/architecture-plans/${review.identity.runId}/approve`, { expectedReviewDigest: review.metadata.reviewDigest });
    const dependencies = { architectureStore: new PostgresArchitectureStore(db), targetStore: new PostgresArchitectureTargetStore(db), releaseDependencies: { skillRepository: new PostgresSkillRepository(db), submissionService: new SubmissionService(new PostgresSubmissionStore(db)) } };
    const deniedNames=[];
    const forbiddenStorage=new S3ArtifactObjectStorage({bucket:"myskills",client:forbiddenClient,requestTimeoutMs:5000});const readForbidden=forbiddenStorage.getObject.bind(forbiddenStorage);
    forbiddenStorage.getObject=async(...args)=>{try{return await readForbidden(...args);}catch(error){deniedNames.push(error.name);throw error;}};
    const forbidden = new ArchitectureArtifactService(new PostgresArchitectureSyncStore(db, { artifactStorage: forbiddenStorage }), dependencies);
    let denied = false;
    try { await forbidden.prepare({ id: data.ownerId, mfaVerified: true, artifactCredential: { kind: "session", hash: hashSessionToken(token) } }, target.id, { reviewRunId: review.identity.runId, baselineRunId: null, idempotencyKey: "minio-denied" }); }
    catch { assert.ok(deniedNames.some(name=>/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/.test(name)), "actual MinIO credential refusal observed"); denied = true; }
    assert.equal(denied, true, "real MinIO permission failure must reject materialization");
    const deniedRows = await pool.query("SELECT count(*) FROM skill_architecture_sync_runs WHERE target_id=$1 AND artifact_intent IS NOT NULL", [target.id]); assert.equal(Number(deniedRows.rows[0].count), 0);
    const candidate = await api(`/v1/architecture-targets/${target.id}/artifacts`, { reviewRunId: review.identity.runId, baselineRunId: null, idempotencyKey: "minio-valid" }, { status: 201 });
    const payloads = new Map();
    for (const pin of pins) {
      const bytes = await api(`/v1/skills/${pin.slug}/releases/${pin.version}/bundle?platform=codex`, undefined, { raw: true }); assert.equal(hash(bytes), pin.digest); payloads.set(pin.id, JSON.parse(bytes.toString()).files);
    }
    const files = core.renderArchitectureArtifact(candidate.intent.projection, payloads); assert.deepEqual(core.identifyArtifactFiles(files), candidate.intent.files);
    const root = "/proof/composed-storage-workspace"; mkdirSync(root, { mode: 0o700 });
    for (const file of files) { const { dirname, join } = await import("node:path"); const location = join(root, file.path); mkdirSync(dirname(location), { recursive: true, mode: 0o700 }); writeFileSync(location, file.content, { mode: 0o600 }); assert.equal(hash(readFileSync(location)), candidate.intent.files.find(entry => entry.path === file.path).digest); }
    await api(`/v1/architecture-artifacts/${candidate.run.identity.runId}/approve`, { expectedIntentDigest: candidate.intentDigest, treeDigest: candidate.intent.treeDigest, baselineDigest: candidate.intent.baselineDigest });
    const claim = await api(`/v1/architecture-artifacts/${candidate.run.identity.runId}/claim`, { holderId: "minio-fixture-holder", expectedIntentDigest: candidate.intentDigest }); assert.equal(claim.decision, "claimed");
    const receipt = await api(`/v1/architecture-artifacts/${candidate.run.identity.runId}/receipt`, { holderId: claim.run.lease.holderId, fencingToken: claim.run.lease.fencingToken, treeDigest: candidate.intent.treeDigest }); assert.equal(receipt.run.state, "succeeded");
    return { status: "passed", runId: candidate.run.identity.runId, treeDigest: candidate.intent.treeDigest, exactObjectBytes: "passed", deniedStorageNoIntent: "passed", localBytes: "fixture-readback", runtimeRecognized: false };
  } finally { forbiddenClient.destroy(); await pool.end(); }
}
