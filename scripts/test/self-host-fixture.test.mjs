import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import test from "node:test";
import { createTotpSecret } from "../../packages/auth/dist/index.js";

// Failure cases before the namespace correction: Ubuntu publication is mistaken
// for Docker host loopback; allocation returns duplicate/invalid ports or leaves
// a listener behind; API readiness accepts a foreign source, redirect, unhealthy
// response, credentials, non-loopback target, oversized body or stalled response.
// Recovery must additionally fail before writes on occupied ports, foreign IDs,
// wrong owner/role/image/network/command, stopped services or unready PG/MinIO.
// Real local sockets/HTTP below cover driver utilities. The exact Docker service
// guards, namespaces, recovery and cleanup require the canonical HOST artifact.
test("host fixture allocates distinct loopback ports and releases every listener", async (t) => {
  const f = networkFixture(t, {}); const result = await runNetworkFixture(f, "host-ports");
  assert.equal(result.status, 0, "host port allocation must succeed");
  const { ports } = JSON.parse(readFileSync(f.file));
  assert.deepEqual(Object.keys(ports).sort(), ["api", "minio", "postgres"]);
  assert.equal(new Set(Object.values(ports)).size, 3);
  for (const value of Object.values(ports)) {
    assert.match(value, /^[1-9][0-9]{3,4}$/); assert.ok(Number(value) >= 1024 && Number(value) <= 65535);
    const socket = createTcpServer();
    await new Promise((done, reject) => { socket.once("error", reject); socket.listen(Number(value), "127.0.0.1", done); });
    await new Promise(done => socket.close(done));
  }
});

test("host fixture readiness requires loopback, healthy HTTP and the exact API source", async (t) => {
  const source = { commit: "a".repeat(40), version: "0.1.0-beta.19" }; const outcomes = {};
  for (const failure of [null, "non-loopback", "credentials", "redirect", "not-ready", "wrong-source", "oversized", "stalled"]) {
    const requests = []; const sockets = new Set();
    const server = createHttpServer((request, response) => {
      requests.push(request.url);
      if (failure === "stalled") return;
      if (failure === "redirect") { response.writeHead(302, { location: "/ready" }); response.end(); return; }
      if (request.url === "/ready") { response.writeHead(failure === "not-ready" ? 503 : 200); response.end("ready"); return; }
      response.setHeader("content-type", "application/json");
      response.end(failure === "oversized" ? "x".repeat(8192) : JSON.stringify({ revision: failure === "wrong-source" ? "b".repeat(40) : source.commit, version: source.version }));
    });
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    const api = `http://${failure === "credentials" ? "private-canary@" : ""}${failure === "non-loopback" ? "remote.invalid" : "127.0.0.1"}:${server.address().port}`;
    const f = networkFixture(t, { api, expectedSource: source, timeoutMs: 400 });
    const result = await runNetworkFixture(f, "api-ready");
    for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done));
    assert.equal(result.status === 0, failure === null, `readiness must reject ${failure ?? "none"}`);
    assert.doesNotMatch(result.output, /private-canary/);
    if (!failure) assert.deepEqual(requests, ["/ready", "/version.json"]);
    if (["non-loopback", "credentials"].includes(failure)) assert.deepEqual(requests, []);
    outcomes[failure ?? "healthy-exact-source"] = result.status === 0 ? "passed" : "rejected";
  }
  writeFileSync(join(tmpdir(), `myskills-host-network-controls-${process.version}.json`), `${JSON.stringify({ schemaVersion: 1, node: process.version, scope: "local-real-sockets-and-http-not-Docker-runtime", outcomes }, null, 2)}\n`, { mode: 0o600 });
});

function networkFixture(t, data) {
  const root = mkdtempSync(join(tmpdir(), "myskills-network-proof-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "proof.json"); writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); return { file };
}
function runNetworkFixture(f, mode) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/lib/self-host-fixture.mjs"), mode, f.file], { timeout: 5000 }); let output = "";
    child.once("error", reject); for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; if (output.length > 16_384) child.kill("SIGKILL"); });
    child.once("close", status => done({ status, output }));
  });
}

// The driver runs unchanged apart from its image-local auth import location.
// Fetch is a deterministic contract stub, not Postgres/restore/MFA runtime proof.
test("restore driver requires real TOTP plus recovery, authenticated non-owner denial revoked-session denial and exact restored evaluation summary", (t) => {
  for (const failure of [null, "totp", "nonowner", "revoked", "evaluation", "suite-id", "suite-digest", "absent-suite-binding", "absent-evaluation"]) {
    const root = mkdtempSync(join(tmpdir(), "myskills-auth-proof-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.from("disposable private package bytes");
    const source = { version: "0.1.0-beta.19", commit: "a".repeat(40) };
    const file = join(root, "proof.json"), script = join(root, "fixture.mjs"), preload = join(root, "fetch.mjs"), trace = join(root, "trace.json");
    const evaluation = { slug: "host-fresh", version: "1.0.0", suiteBinding: failure === "absent-suite-binding" ? undefined : { revisionId: "original-suite-revision", sha256: "b".repeat(64) }, record: { id: "eval", versionId: "submission", createdAt: "2026-10-01T00:00:00.000Z", summary: { artifactSha256: "a".repeat(64), runner: { id: "package-static", version: "1" }, provenance: "api-owned", status: "skipped", totals: { pass: 3, fail: 0, warning: 0, skipped: 1, incompatible: 0 } } } };
    const auth = pathToFileURL(resolve("packages/auth/dist/index.js")).href;
    writeFileSync(script, readFileSync(resolve("scripts/lib/self-host-fixture.mjs"), "utf8").replaceAll("/app/packages/auth/dist/index.js", auth));
    writeFileSync(file, JSON.stringify({ api: "http://fixture.invalid", expectedSource: source,
      instanceId: "11111111-1111-4111-8111-111111111111", ownerId: "owner", SEED_OWNER_EMAIL: "owner@operator.test", SEED_OWNER_PASSWORD: randomBytes(24).toString("hex"),
      mfaSecret: createTotpSecret(), enrolledTotpCounter: Math.floor(Date.now() / 30_000) - 1, recoveryCodes: ["disposable-recovery"], revokedSessionToken: randomBytes(24).toString("hex"),
      nonowner: { id: "nonowner", email: "nonowner@operator.test", password: randomBytes(24).toString("hex") },
      evaluationProof: failure === "absent-evaluation" ? undefined : evaluation, architectureId: "architecture", submissionId: "submission", packageSha256: createHash("sha256").update(bytes).digest("hex"), packageBytes: bytes.length, originalScanCount: 1 }), { mode: 0o600 });
    writeFileSync(preload, `import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {readFileSync,writeFileSync} from 'node:fs';import {verifyTotpCode} from ${JSON.stringify(auth)};
const data=JSON.parse(readFileSync(${JSON.stringify(file)}));const failure=${JSON.stringify(failure)};const ownerToken=randomBytes(24).toString('hex'),nonownerToken=randomBytes(24).toString('hex');const trace={totpSeen:false,recoverySeen:false};
globalThis.fetch=async (url,options={})=>{const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):null,token=options.headers?.authorization?.slice(7);let status=200,result;
if(path==='/version.json')result={version:data.expectedSource.version,revision:data.expectedSource.commit};
else if(path==='/v1/capabilities')result={instanceId:data.instanceId,capabilities:{evaluations:failure!=='absent-evaluation'}};
else if(path==='/v1/auth/login')result=body.email===data.nonowner.email?{token:nonownerToken,user:{id:data.nonowner.id,roles:['user']}}:{challengeToken:'disposable-challenge'};
else if(path==='/v1/auth/mfa/verify'){if(body.code){trace.totpSeen=true;assert.ok(verifyTotpCode(data.mfaSecret,body.code,{window:1}).valid);}else{trace.recoverySeen=true;assert.equal(body.recoveryCode,'disposable-recovery');}status=body.code&&failure==='totp'?401:200;result={token:ownerToken,user:{id:data.ownerId,mfaVerified:true}};}
else if(path==='/v1/submissions/submission/bundle'){status=!token?401:token===data.revokedSessionToken?failure==='revoked'?200:401:token===nonownerToken?failure==='nonowner'?200:404:200;result=status===200?${JSON.stringify(bytes.toString())}:{};}
else if(path==='/v1/evaluations/releases/host-fresh/1.0.0/summary'){const record=structuredClone(data.evaluationProof.record);if(failure==='evaluation')record.summary.artifactSha256='c'.repeat(64);result={runs:[record]};}
else if(path==='/v1/evaluations/releases/host-fresh/1.0.0/runs'){const record=data.evaluationProof.record;result={runs:[{id:record.id,versionId:record.versionId,suiteRevisionId:failure==='suite-id'?'changed-suite-revision':'original-suite-revision',createdAt:record.createdAt,result:{...record.summary,suiteSha256:failure==='suite-digest'?'c'.repeat(64):'b'.repeat(64),assertions:[]}}]};}
else if(path==='/v1/architectures/architecture')result={architecture:{id:'architecture'}};
else if(path==='/v1/submissions/submission')result={submission:{feedback:{scanRuns:[{completedAt:'2026-10-01T00:00:00.000Z'}]}}};
else{status=404;result={};}writeFileSync(${JSON.stringify(trace)},JSON.stringify(trace));return new Response(typeof result==='string'?result:JSON.stringify(result),{status});};
`);
    const child = spawnSync(process.execPath, ["--import", preload, script, "verify", file], { stdio: "ignore", timeout: 10_000 });
    assert.equal(child.status === 0, failure === null || failure === "absent-evaluation", `fixture must reject missing ${failure ?? "none"} proof`);
    const seen = JSON.parse(readFileSync(trace)); assert.equal(seen.totpSeen, true);
    if (!failure || failure === "absent-evaluation") { assert.equal(seen.recoverySeen, true); assert.equal(JSON.parse(readFileSync(file)).authProof.totp, "original-factor-decrypted-and-verified"); assert.equal(JSON.parse(readFileSync(file)).persistedBoundaries.evaluation, failure === "absent-evaluation" ? "not-exercised" : "restored-exact-summary"); }
  }
});
