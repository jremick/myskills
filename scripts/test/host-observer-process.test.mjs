import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:https";
import { observerCommand, observerTls } from "../lib/host-observer-process.mjs";
import { hostPublicationDirectory } from "../lib/host-backup-service.mjs";

test("actual observer cooperatively cancels waiting admission and reaps its active detached adapter within eleven seconds", { timeout: 15000 }, async () => {
  const directory = hostPublicationDirectory;
  // The exact CLI owns this fixed private handoff. Never use or clean an existing directory.
  assert.equal(existsSync(directory), false);
  for (const active of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "host-observer-cancel-")); let observer; let adapterPid; let owned = false;
    const adapter = { script: `exec node -e 'require("node:fs").writeFileSync("adapter.pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'`,
      backendStopProtocol: "timeout7-kill025-process-group", terminationProbeSha256: "e".repeat(64) };
    const path = join(root, "adapter.json"); writeFileSync(path, JSON.stringify(adapter), { mode: 0o600 });
    const digest = createHash("sha256").update(adapter.script).digest("hex"), candidate = "d".repeat(40), runId = "owned-cancellation-control";
    const wait = async predicate => { const until = Date.now() + 2500; while (!predicate()) {
      assert.ok(Date.now() < until, "owned fixture handshake deadline"); await new Promise(done => setTimeout(done, 10)); } };
    try {
      observer = spawn(process.execPath, [new URL("../observe-host-publication-once.mjs", import.meta.url).pathname, path, digest, candidate, runId],
        { cwd: root, detached: true, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
      const completion = new Promise(resolve => observer.once("close", (code, signal) => resolve({ code, signal })));
      let output = ""; for (const pipe of [observer.stdout, observer.stderr]) pipe.on("data", bytes => { output += bytes; assert.ok(output.length <= 2048); });
      await wait(() => existsSync(join(directory, "ready.json")));
      const ready = JSON.parse(readFileSync(join(directory, "ready.json"))); owned = ready.candidate === candidate && ready.runId === runId;
      assert.equal(owned, true); assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      const request = { candidate, runId, nonce: ready.nonce, token: "a".repeat(32), owner: "hc-0123456789abcdef",
        containerId: "a".repeat(64), networkId: "b".repeat(64), endpointId: "c".repeat(64), gateway: "172.28.0.1", address: "172.28.0.2", deadlineMs: Date.now() + 12000 };
      if (active) { writeFileSync(join(directory, "request.json"), JSON.stringify(request), { mode: 0o600 });
        await wait(() => existsSync(join(root, "adapter.pid"))); adapterPid = Number(readFileSync(join(root, "adapter.pid"))); }
      const cancelledAt = Date.now(); process.kill(-observer.pid, "SIGTERM");
      if (active) { await new Promise(done => setTimeout(done, 25)); process.kill(-observer.pid, "SIGTERM"); }
      if (!active) writeFileSync(join(directory, "request.json"), JSON.stringify(request), { mode: 0o600 });
      const forced = setTimeout(() => process.kill(-observer.pid, "SIGKILL"), 11000);
      let result; try { result = await completion; } finally { clearTimeout(forced); }
      assert.deepEqual(result, { code: 0, signal: null }); assert.ok(Date.now() - cancelledAt < 11000);
      assert.match(output, /observer-cancelled/); assert.doesNotMatch(output, /172\.28|adapter\.pid/);
      assert.match(output, active ? /"adapterTermination":"confirmed"/ : /"adapterTermination":"not-started"/);
      assert.throws(() => process.kill(-observer.pid, 0), { code: "ESRCH" });
      if (active) assert.throws(() => process.kill(-adapterPid, 0), { code: "ESRCH" });
      else assert.equal(existsSync(join(root, "adapter.pid")), false);
      assert.equal(existsSync(join(directory, "ready.json")), false);
    } finally {
      for (const pid of [observer?.pid, adapterPid].filter(Boolean)) { try { process.kill(-pid, "SIGKILL"); } catch { /* only owned fixture groups */ } }
      if (owned) rmSync(directory, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
    }
  }
});

for (const mode of ["timeout", "overflow", "ignored-term", "descendant"]) test(`real observer process ${mode} is forcibly bounded`, { timeout: 3000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "host-observer-process-")); const childFile = join(root, "child.json");
  const code = mode === "descendant"
    ? `const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});c.on('spawn',()=>{require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:c.pid}));setTimeout(()=>process.exit(0),30)});`
    : `process.on('SIGTERM',()=>{});${mode === "overflow" ? "process.stdout.write('SECRET'.repeat(10000));" : ""}setInterval(()=>{},1000);`;
  const start = Date.now();
  try {
    const result = await observerCommand(process.execPath, ["-e", code, childFile], { maximumMs: 1500, maximumBytes: 2048 });
    assert.ok(Date.now() - start < 2000); assert.equal(result.groupTerminationConfirmed, true);
    assert.equal(result.category, mode === "overflow" ? "output-invalid" : mode === "descendant" ? "completed" : "deadline");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    if (mode === "descendant") { const pid = JSON.parse(readFileSync(childFile)).pid; assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("synchronous Docker diagnostic kills an executable ignoring SIGTERM under its selected budget", () => {
  const started = Date.now(); const result = spawnSync(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { timeout: 100, killSignal: "SIGKILL", maxBuffer: 2048 });
  assert.equal(result.signal, "SIGKILL"); assert.equal(result.error.code, "ETIMEDOUT"); assert.ok(Date.now() - started < 1500);
});

test("real conditional TLS uses the public CA, fixed health path, no proxy, no retry and a finite deadline", { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "host-observer-tls-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "key"),
    "-out", join(root, "cert"), "-subj", "/CN=public test", "-addext", "subjectAltName=IP:127.0.0.1"], { timeout: 3000, killSignal: "SIGKILL", stdio: "ignore" });
  assert.equal(generated.status, 0); const publicCertificate = readFileSync(join(root, "cert"), "utf8"); let hits = 0;
  const server = createServer({ key: readFileSync(join(root, "key")), cert: publicCertificate }, (req, res) => {
    hits++; assert.equal(req.url, "/minio/health/ready"); if (hits === 3) return; res.writeHead(hits === 1 ? 200 : 503); res.end("PRIVATE body must not export");
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done)); t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const vars = { gateway: "127.0.0.1", port: String(server.address().port), publicCertificate, maximumMs: 100 };
  assert.equal(await observerTls(vars), "ready"); assert.equal(await observerTls(vars), "not-ready"); assert.equal(await observerTls(vars), "deadline"); assert.equal(hits, 3);
  assert.equal(await observerTls({ ...vars, publicCertificate: "PRIVATE KEY" }), "unavailable"); assert.equal(hits, 3);
  const other = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "other-key"),
    "-out", join(root, "other-cert"), "-subj", "/CN=other public test"], { timeout: 3000, killSignal: "SIGKILL", stdio: "ignore" });
  assert.equal(other.status, 0);
  assert.equal(await observerTls({ ...vars, publicCertificate: readFileSync(join(root, "other-cert"), "utf8") }), "tls-rejected"); assert.equal(hits, 3);
  const wrong = publicCertificate.replace("CERTIFICATE", "INVALID"); assert.equal(await observerTls({ ...vars, publicCertificate: wrong }), "unavailable");
});
