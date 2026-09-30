// Mounted into the real candidate API/OPS images by the internal rehearsal.
// Fixture credentials, tokens, MFA seeds and package contents stay in /proof.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
    while (Date.now() < until && (!submission.submission.feedback?.scanRuns?.length
      || submission.submission.feedback.scanRuns.some((run) => !run.completedAt))) {
      await new Promise((done) => setTimeout(done, 500)); submission = await api(`/v1/submissions/${data.submissionId}`);
    }
    assert.ok(submission.submission.feedback?.scanRuns?.length, "fixture requires durable scan evidence");
  }
  const scans = submission.submission.feedback?.scanRuns ?? [];
  if (mode === "create") data.originalScanCount = scans.length;
  else assert.ok(scans.length >= data.originalScanCount, "original scan rows must survive the transition");
  data.persistedFeedback = { securityStatus: submission.submission?.securityStatus ?? null, scanCount: scans.length };
  // Added draft routes are exercised only when present in the exact integrated
  // source; current baseline has no draft or eval creation surface.
  data.persistedBoundaries = { draft: data.draftId ? "tested" : "not-available-on-source", evaluation: "not-exercised", architecture: "tested", submission: "tested", scanFeedback: "read" };
  save();
}
console.log(JSON.stringify({ passed: true, fixture: mode }));
