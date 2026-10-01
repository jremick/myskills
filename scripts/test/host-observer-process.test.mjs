import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { observerCommand, observerTls } from "../lib/host-observer-process.mjs";

for (const mode of ["timeout", "overflow", "ignored-term", "descendant"]) test(`real observer process ${mode} is forcibly bounded`, { timeout: 3000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "host-observer-process-")); const childFile = join(root, "child.json");
  const code = mode === "descendant"
    ? `const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});c.on('spawn',()=>{require('node:fs').writeFileSync(${JSON.stringify(childFile)},JSON.stringify({pid:c.pid}));setTimeout(()=>process.exit(0),30)});`
    : `process.on('SIGTERM',()=>{});${mode === "overflow" ? "process.stdout.write('SECRET'.repeat(10000));" : ""}setInterval(()=>{},1000);`;
  const start = Date.now();
  try {
    const result = await observerCommand(process.execPath, ["-e", code], { maximumMs: 1500, maximumBytes: 2048 });
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
