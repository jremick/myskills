import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import test from "node:test";
import { backupInvocationReceipt, captureHostDockerIdentity } from "../lib/host-backup-diagnostics.mjs";
import { cleanupHostLedger, hostDocker, saveHostLedger } from "../lib/host-rehearsal-resources.mjs";
import { assertHostCommandSucceeded } from "../lib/host-backup-service.mjs";

const owner = "hc-0123456789abcdef";
const hostBackupStartCommand = 'attempts=0; while [ ! -f /certs/ready ]; do [ "$attempts" -lt 300 ] || exit 1; attempts=$((attempts + 1)); sleep 0.1; done; if [ ! -s /certs/private.key ] || [ ! -s /certs/public.crt ]; then exit 1; fi; exec /usr/local/bin/minio server /data --certs-dir /certs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "host-dispatch-private-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "docker"), ledger = join(root, "ledger.json"), dispatched = join(root, "dispatch.json");
  const contract = { owner, network: `${owner}-backup-network`, gateway: "172.28.0.1", image: "fixture-minio",
    envFile: join(root, "private.env"), certs: join(root, "private-certs") };
  writeFileSync(contract.envFile, "SYNTHETIC_HOST_CONTROL=true\n", { mode: 0o600 });
  const args = ["run", "--rm", "--rm=true", "-d", "--label", "io.myskills.host-rehearsal.role=backup", "--network", contract.network,
    "--publish", "127.0.0.1::9000", "--env-file", contract.envFile, "--mount", `type=bind,source=${contract.certs},target=/certs,readonly`,
    "--entrypoint", "/bin/sh", contract.image, "-ec", hostBackupStartCommand];
  saveHostLedger(ledger, { schemaVersion: 1, owner, sequence: 0, resources: [] });
  writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
if(a[0]==='run'){fs.writeFileSync(${JSON.stringify(dispatched)},JSON.stringify(a));console.log('a'.repeat(64));}
if(a[1]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'io.myskills.host-rehearsal':${JSON.stringify(owner)}}}}]));
`, { mode: 0o755 });
  return { root, executable, ledger, dispatched, contract, args };
}
test("backup receipt observes final argv after both --rm removals and ownership insertion; cleanup stays exact", t => {
  const f = fixture(t); let receipt;
  const result = hostDocker(f.ledger, f.executable, f.args, { encoding: "utf8" }, { contract: f.contract, record: value => { receipt = value; } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(receipt.category, "matched"); assert.equal(receipt.vectorMatches, true); assert.equal(receipt.ownershipMatches, true);
  const final = JSON.parse(readFileSync(f.dispatched));
  assert.deepEqual(receipt, backupInvocationReceipt(final, f.contract, owner, `${owner}-op-1`));
  assert.equal(final.includes("--rm"), false); assert.equal(final.includes("--rm=true"), false);
  assert.equal(backupInvocationReceipt(f.args, f.contract, owner, `${owner}-op-1`).vectorMatches, false, "the pre-wrapper vector cannot supply proof");
  assert.doesNotMatch(JSON.stringify(receipt), /host-dispatch-private|172\.28|hc-|private\.env|fixture-minio/);
  assert.deepEqual(cleanupHostLedger(f.ledger, f.executable), []);
  assert.equal(JSON.parse(readFileSync(f.ledger)).cleanup, "complete");
});
test("receipt detects each contract mismatch without changing dispatch, parsing or reservation", t => {
  const cases = [
    ["network", args => { args[args.indexOf("--network") + 1] = "foreign-private-network"; }, "networkMatches"],
    ["publication", args => { args[args.indexOf("--publish") + 1] = "0.0.0.0::9000"; }, "publishMatches"],
    ["duplicate publication", args => { args.splice(args.indexOf("--publish"), 0, "--publish", "secret.invalid::9000"); }, "publishMatches"],
    ["image position", args => { args.splice(args.indexOf("fixture-minio"), 0, "--env", "PASSWORD=secret-password"); }, "imagePositionMatches"],
    ["mount", args => { args[args.indexOf("--mount") + 1] = "type=bind,source=/secret/path,target=/certs"; }, "mountMatches"],
    ["entrypoint", args => { args[args.indexOf("--entrypoint") + 1] = "/secret/path"; }, "entrypointMatches"],
    ["tail", args => { args[args.length - 1] = "/secret/path"; }, "tailMatches"],
    ["role", args => { args[args.indexOf("--label") + 1] = "io.myskills.host-rehearsal.role=driver"; }, "ownershipMatches"],
  ];
  for (const [name, change, field] of cases) {
    const f = fixture(t); change(f.args); let receipt;
    const result = hostDocker(f.ledger, f.executable, f.args, { encoding: "utf8" }, { contract: f.contract, record: value => { receipt = value; } });
    assert.equal(result.stdout.trim(), "a".repeat(64), name); assert.equal(receipt.category, "mismatch", name); assert.equal(receipt[field], false, name);
    assert.doesNotMatch(JSON.stringify(receipt), /secret|foreign|private|172\.28|0\.0\.0/);
    assert.equal(JSON.parse(readFileSync(f.ledger)).resources[0].state, "created");
    assert.deepEqual(cleanupHostLedger(f.ledger, f.executable), []);
  }
  const f = fixture(t); let receipt;
  hostDocker(f.ledger, f.executable, f.args, { encoding: "utf8" }, { contract: { ...f.contract, owner: "foreign" }, record: value => { receipt = value; } });
  assert.deepEqual(receipt, { category: "contract-invalid" });
  assert.equal(hostDocker(f.ledger, f.executable, f.args, { encoding: "utf8" }, { contract: f.contract, record: () => { throw new Error("secret"); } }).status, 0);
});
test("maintained rehearsal callers forward only the explicit backup contract and preserve command output limits", t => {
  const f = fixture(t), receipt = {}, calls = [];
  const source = readFileSync(new URL("../rehearse-self-host.mjs", import.meta.url), "utf8");
  // Execute the actual two caller functions with the existing fake-executable
  // boundary. The full Linux/Docker rehearsal is deliberately not executed.
  const functions = source.slice(source.indexOf("function docker("), source.indexOf("async function measured("));
  const { docker, runService } = new Function("hostDocker", "call", "ledgerPath", "executable", "root", "receipt", "assert", "assertHostCommandSucceeded",
    `${functions}\nreturn {docker,runService};`)(hostDocker, (...args) => { calls.push(args); return { status: 0 }; }, f.ledger, f.executable, f.root, receipt, assert, assertHostCommandSucceeded);
  const before = f.args.filter(value => value !== "--rm" && value !== "--rm=true");
  const start = before.indexOf("--network"), end = before.indexOf(f.contract.image);
  assert.equal(runService("backup", before.slice(start, end), f.contract.image, before.slice(end + 1), f.contract), "a".repeat(64));
  assert.equal(receipt.backupInvocation.category, "matched");
  const prior = receipt.backupInvocation;
  assert.equal(runService("driver", [], "fixture-image"), "a".repeat(64)); assert.equal(receipt.backupInvocation, prior);
  const options = { timeout: 10_000, maxBuffer: 128 * 1024 };
  docker(["container", "inspect", "a".repeat(64)], options);
  assert.deepEqual(calls, [[f.executable, ["container", "inspect", "a".repeat(64)], options]]);
  const callFunction = source.slice(source.indexOf("function call("), source.indexOf("function reserve("));
  const boundedCall = new Function("spawnSync", "assertHostCommandSucceeded", "root", `${callFunction}\nreturn call;`)(
    (command, args, settings) => { assert.equal(command, f.executable); assert.deepEqual(args, ["network", "inspect", "b".repeat(64)]); assert.equal(settings.maxBuffer, options.maxBuffer); assert.equal(settings.timeout, options.timeout); assert.equal(settings.shell, false); assert.deepEqual(settings.stdio, ["ignore", "pipe", "pipe"]); return { status: 0, stdout: "", stderr: "" }; },
    () => {}, f.root);
  assert.equal(boundedCall(f.executable, ["network", "inspect", "b".repeat(64)], options).status, 0);
  assert.throws(() => boundedCall(f.executable, ["ok\n"], options), /command-invalid/);
  assert.throws(() => boundedCall(f.executable, ["ok"], { ...options, env: { PATH: "a\nb" } }), /command-invalid/);
});
test("same selected symlink executable supplies distinct client/server identities and a descriptor digest", t => {
  const f = fixture(t), selected = join(f.root, "selected-docker");
  const client = { Version: "27.5.1", GitCommit: "abcdef1", ApiVersion: "1.47", Os: "linux", Arch: "amd64", Context: "secret-password", Config: "/private/path" };
  const server = { Version: "28.3.0", GitCommit: "1234567", ApiVersion: "1.51", Os: "linux", Arch: "arm64", Components: [{ Name: "secret-password" }] };
  writeFileSync(f.executable, `#!${process.execPath}\nconst a=process.argv.slice(2);if(JSON.stringify(a)!==JSON.stringify(['version','--format','{{json .}}']))process.exit(99);console.log(${JSON.stringify(JSON.stringify({ Client: client, Server: server }))});\n`);
  symlinkSync(f.executable, selected);
  const result = captureHostDockerIdentity(selected);
  assert.deepEqual(result.executable, { category: "regular-executable", sha256: createHash("sha256").update(readFileSync(f.executable)).digest("hex") });
  assert.deepEqual(result.version.client, { category: "captured", version: "27.5.1", gitCommit: "abcdef1", apiVersion: "1.47", os: "linux", architecture: "amd64" });
  assert.deepEqual(result.version.server, { category: "captured", version: "28.3.0", gitCommit: "1234567", apiVersion: "1.51", os: "linux", architecture: "arm64" });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|Context|Config|Components|host-dispatch/);
});
test("identity capture failures remain fixed, bounded diagnostics without raw output or file contents", t => {
  const f = fixture(t);
  writeFileSync(f.executable, `#!${process.execPath}\nconsole.log(JSON.stringify({Client:{Version:'27.5.1',GitCommit:'secret-password',ApiVersion:'secret-password',Os:'private-path',Arch:'private-path',Env:['PASSWORD=secret-password']}}));console.error('secret-password');process.exit(1);\n`);
  const failed = captureHostDockerIdentity(f.executable);
  assert.equal(failed.version.category, "command-failed"); assert.equal(failed.version.client.version, "27.5.1");
  assert.equal(failed.version.client.gitCommit, null); assert.equal(failed.version.client.os, null); assert.equal(failed.version.client.architecture, null);
  assert.deepEqual(failed.version.server, { category: "missing-or-invalid" });
  writeFileSync(f.executable, `#!${process.execPath}\nconsole.log('secret-password');\n`);
  assert.equal(captureHostDockerIdentity(f.executable).version.category, "json-invalid");
  writeFileSync(f.executable, `#!${process.execPath}\nprocess.stdout.write('secret-password'.repeat(100000));\n`);
  assert.equal(captureHostDockerIdentity(f.executable).version.category, "output-limit");
  const oversized = join(f.root, "oversized"); writeFileSync(oversized, "#!/bin/sh\nexit 1\n", { mode: 0o700 }); truncateSync(oversized, 128 * 1024 * 1024 + 1);
  assert.deepEqual(captureHostDockerIdentity(oversized).executable, { category: "size-limit", sha256: null });
  const directory = join(f.root, "directory"); mkdirSync(directory);
  assert.equal(captureHostDockerIdentity(directory).executable.category, "not-regular");
  assert.equal(captureHostDockerIdentity(join(f.root, "absent")).executable.category, "identity-unavailable");
  const plain = join(f.root, "plain"); writeFileSync(plain, "secret-password", { mode: 0o600 });
  assert.equal(captureHostDockerIdentity(plain).executable.category, "not-executable");
  assert.doesNotMatch(JSON.stringify(failed), /secret-password|private-path|Env|PASSWORD|host-dispatch/);
});
test("docker lookup rejects relative PATH entries and will not exec the proof/bin shim", (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-docker-path-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(new URL("../rehearse-self-host.mjs", import.meta.url), "utf8");
  const fnText = source.slice(source.indexOf("function resolveDockerExecutable("), source.indexOf("\nconst executable = resolveDockerExecutable()"));
  const relative = "relative-bin";
  mkdirSync(join(root, relative));
  writeFileSync(join(root, relative, "docker"), "#!/bin/sh\necho relative\n", { mode: 0o755 });
  writeFileSync(join(root, "docker"), "#!/bin/sh\necho dot\n", { mode: 0o755 });
  const absolute = join(root, "abs-bin"); mkdirSync(absolute);
  const binary = join(absolute, "docker");
  writeFileSync(binary, "#!/bin/sh\necho absolute\n", { mode: 0o755 });
  const proof = join(root, "proof"); const shimDir = join(proof, "bin"); mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "docker"), "#!/bin/sh\necho shim\n", { mode: 0o755 });
  const linkedDir = join(root, "linked-bin"); mkdirSync(linkedDir);
  const target = join(root, "real-docker"); writeFileSync(target, "#!/bin/sh\necho real\n", { mode: 0o755 });
  symlinkSync(target, join(linkedDir, "docker"));
  // cwd is the temp root, so a missing isAbsolute check would execute ./docker and relative-bin/docker.
  const program = `import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
${fnText}
const proof = ${JSON.stringify(proof)};
process.stdout.write(JSON.stringify({
  dot: resolveDockerExecutable(".", proof),
  relative: resolveDockerExecutable(${JSON.stringify(relative)}, proof),
  mixed: resolveDockerExecutable(${JSON.stringify(`${relative}:${absolute}`)}, proof),
  shim: resolveDockerExecutable(${JSON.stringify(`${shimDir}:${relative}`)}, proof),
  shimThenAbsolute: resolveDockerExecutable(${JSON.stringify(`${shimDir}:${absolute}`)}, proof),
  linked: resolveDockerExecutable(${JSON.stringify(linkedDir)}, proof),
}));
`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
  const cases = JSON.parse(run.stdout);
  assert.equal(cases.dot, "");
  assert.equal(cases.relative, "");
  assert.equal(cases.mixed, realpathSync(binary));
  assert.equal(cases.shim, "");
  assert.equal(cases.shimThenAbsolute, realpathSync(binary));
  assert.equal(cases.linked, realpathSync(target));
  assert.equal(isAbsolute(cases.linked), true);
  assert.equal(cases.linked.startsWith(`${shimDir}${sep}`), false);
});
test("rehearsal call captures child stderr and does not leak it to the parent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-call-stderr-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(new URL("../rehearse-self-host.mjs", import.meta.url), "utf8");
  const callFunction = source.slice(source.indexOf("function call("), source.indexOf("function reserve("));
  const program = `import { spawnSync } from "node:child_process";
const assertHostCommandSucceeded = () => { throw new Error("should-not-run"); };
const root = ${JSON.stringify(root)};
${callFunction}
const result = call(process.execPath, ["-e", "process.stderr.write('STDERR_CANARY'); process.stdout.write('ok');"], { ok: false, timeout: 5000 });
if (result.status !== 0 || result.stdout !== "ok" || result.stderr !== "STDERR_CANARY") process.exit(2);
process.stdout.write("captured");
`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "captured");
  assert.doesNotMatch(run.stderr ?? "", /STDERR_CANARY/);
});
